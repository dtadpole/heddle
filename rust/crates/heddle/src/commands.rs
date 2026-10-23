//! Every command, ported from `main`, `runWeb`, `runConfigCommand` and `runCommand` in `src/cli.ts`.
//!
//! Each function takes the parsed [`Args`], the [`Invocation`] and an [`Output`], and returns the
//! [`Exit`] the process ends with. The commands that boot read the booted tree only through
//! [`Services`] and its [`ports`](crate::ports) views, so each one is unit-tested against doubles of
//! those views; a profile that leaves a service out gets the TypeScript build's sentence for it.

use crate::boot::Boot;
use crate::cli::{Args, CommandWord};
use crate::output::Output;
use crate::services::Services;
use crate::usage::{Capability, served};
use crate::{Exit, Invocation};

/// Route a parsed command line: port of `main()` after `parseArgs`.
///
/// `--help` → [`crate::usage::usage`]; `web` → [`web`]; `profiles` and `config` → [`config_command`]
/// without booting; any other command word → [`booted_command`]; no command and no tree named →
/// [`bare_application`]; otherwise boot, check the tree, and either print it or run [`turn`].
///
/// A command whose capability is not served yet exits [`Exit::Unported`] naming itself, which is what
/// keeps a verifier from judging a part that does not exist.
pub fn dispatch(args: &Args, invocation: &Invocation, out: &mut Output<'_>) -> Exit {
    if let Some(command) = args.command {
        return match command {
            CommandWord::Web if served(Capability::Web) => web(args, invocation, out),
            CommandWord::Profiles | CommandWord::Config if served(Capability::Config) => {
                config_command(args, invocation, out)
            }
            other => unported(other.as_str(), out),
        };
    }
    if args.turn.is_some() {
        return unported("--turn", out);
    }
    let project_base = invocation.cwd.join(heddle_config::PROJECT_BASE).exists();
    if crate::cli::names_a_tree(args, project_base) {
        unported("the configured tree", out)
    } else {
        unported("the bare application", out)
    }
}

/// A request whose part is not wired yet: the binary says so on stderr and exits 2, so a verifier
/// reports unjudged rather than passing on an empty answer.
fn unported(what: &str, out: &mut Output<'_>) -> Exit {
    out.err(&format!("heddle: not ported to Rust yet: {what}\n"));
    Exit::Unported
}

/// `profiles`, `config`, `config --validate`, `config --origins`, each with `--json`: answered from the
/// configuration alone, so they work on a tree that is broken — which is when they are needed.
///
/// `heddle-config` owns these commands' every sentence (`heddle_config::command::run`); the binary
/// passes [`crate::cli::config_args`], the environment, the working directory and its
/// [`BuiltinCatalog`](crate::builtins::BuiltinCatalog) as the schema catalog, and maps the exit code.
pub fn config_command(args: &Args, invocation: &Invocation, out: &mut Output<'_>) -> Exit {
    let _ = (args, invocation, out);
    todo!("delegate to heddle_config::command::run")
}

/// The commands that boot and then answer: `models`, `tools`, `commands`, `sessions`, `transcript`,
/// `workspaces`, `workspace add|list|remove|rename`, `tree`, `session new`, `file`, `hooks`, `goal`,
/// `context`. A row that failed to load is reported first (`heddle: N row(s) failed to load: …`, exit 1),
/// and the tool allow list is applied before any of them answers.
pub fn booted_command(
    args: &Args,
    invocation: &Invocation,
    boot: &Boot,
    out: &mut Output<'_>,
) -> Exit {
    let _ = (args, invocation, boot, out);
    todo!("port runCommand from src/cli.ts")
}

/// A bare `heddle` with no tree named: the three-plugin application of `src/app.ts` (`console-exporter`
/// unless `-q`, `Greeting`, `announce`), its tree printed, then `heddle/ready` announced, which prints
/// `announce hello, <target><punctuation>` through the console exporter.
pub fn bare_application(args: &Args, out: &mut Output<'_>) -> Exit {
    let _ = (args, out);
    todo!("port createApp from src/app.ts and the bare branch of main()")
}

/// `--turn <text>`: the folder's session (or `--resume`'s), its workspace ensured, the turn run, the goal
/// driver joined, and the answer printed as text or `--json`. Exit 1 on a denial other than `UNKNOWN_TOOL`.
pub fn turn(
    args: &Args,
    invocation: &Invocation,
    services: &Services,
    out: &mut Output<'_>,
) -> Exit {
    let _ = (args, invocation, services, out);
    todo!("port the turn branch of main() from src/cli.ts")
}

/// `web`: boot, settle, then either print the plan (`--dry-run`) or start the server, resume active goals,
/// recover teams, print `heddle web: <url>` and `heddle web: serving on <host>:<port>; pass --port to
/// change it` (and the `--json` line), and serve until SIGINT or SIGTERM.
pub fn web(args: &Args, invocation: &Invocation, out: &mut Output<'_>) -> Exit {
    let _ = (args, invocation, out);
    todo!("port runWeb from src/cli.ts over heddle-server")
}

/// One hook point this build emits: `hooks` lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HookPoint {
    /// The event name.
    pub name: &'static str,
    /// How listeners combine: `waterfall` or `emit`.
    pub mode: &'static str,
    /// What a listener may do there.
    pub what: &'static str,
}

/// The hook points, as `hooks` lists them in `src/cli.ts`.
pub const HOOK_POINTS: &[HookPoint] = &[
    HookPoint {
        name: "agent/pre-step",
        mode: "waterfall",
        what: "before a round request is built; may replace messages or tools",
    },
    HookPoint {
        name: "model/request",
        mode: "waterfall",
        what: "before an adapter is chosen; may replace the request",
    },
    HookPoint {
        name: "model/stream",
        mode: "waterfall",
        what: "around the adapter stream; may yield its own chunks",
    },
    HookPoint {
        name: "tools/pre-execute",
        mode: "waterfall",
        what: "before a tool runs; may refuse it",
    },
    HookPoint {
        name: "tools/post-execute",
        mode: "waterfall",
        what: "after a tool runs; may replace the result",
    },
    HookPoint {
        name: "session/event",
        mode: "emit",
        what: "after an event reaches the session file",
    },
];

/// `hooks` as text: a count line, then each point's name padded to 20 and mode padded to 10.
pub fn describe_hooks(points: &[HookPoint]) -> String {
    let mut text = format!("heddle: {} hook point(s)\n", points.len());
    for point in points {
        text.push_str(&format!(
            "  {:<20} {:<10} {}\n",
            point.name, point.mode, point.what
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::output::Captured;
    use heddle_config::Env;
    use std::path::PathBuf;

    fn parsed(argv: &[&str]) -> Args {
        let list: Vec<String> = argv.iter().map(|word| (*word).to_owned()).collect();
        crate::cli::parse_args(&list).expect("the command line parses")
    }

    fn invocation(cwd: &str) -> Invocation {
        Invocation {
            argv: Vec::new(),
            env: Env::from_pairs(Vec::<(String, String)>::new()),
            cwd: PathBuf::from(cwd),
        }
    }

    #[test]
    fn a_command_whose_crate_is_not_wired_says_so_and_exits_two() {
        for word in ["web", "profiles", "config", "models", "hooks", "workspaces"] {
            let mut captured = Captured::default();
            let exit = {
                let mut out = captured.output();
                dispatch(&parsed(&[word]), &invocation("/nonexistent"), &mut out)
            };
            assert_eq!(exit, Exit::Unported, "{word}");
            assert_eq!(
                captured.stderr_text(),
                format!("heddle: not ported to Rust yet: {word}\n"),
                "{word}"
            );
            assert!(captured.stdout.is_empty(), "{word} prints no answer");
        }
    }

    #[test]
    fn a_turn_names_its_flag_and_a_bare_run_names_the_application() {
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--turn", "hello"]),
                &invocation("/nonexistent"),
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Unported);
        assert_eq!(
            captured.stderr_text(),
            "heddle: not ported to Rust yet: --turn\n"
        );

        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(&Args::default(), &invocation("/nonexistent"), &mut out)
        };
        assert_eq!(exit, Exit::Unported);
        assert_eq!(
            captured.stderr_text(),
            "heddle: not ported to Rust yet: the bare application\n"
        );
    }

    #[test]
    fn a_run_that_names_a_tree_says_the_tree_is_what_is_unported() {
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--profile", "dev"]),
                &invocation("/nonexistent"),
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Unported);
        assert_eq!(
            captured.stderr_text(),
            "heddle: not ported to Rust yet: the configured tree\n"
        );
    }

    #[test]
    fn hooks_print_as_the_typescript_build_prints_them() {
        // Measured against `node dist/cli.js hooks` in an empty folder, 2026-10-22.
        // (A `\` line continuation would strip the two leading spaces, so the lines are joined instead.)
        let expected = [
            "heddle: 6 hook point(s)",
            "  agent/pre-step       waterfall  before a round request is built; may replace messages or tools",
            "  model/request        waterfall  before an adapter is chosen; may replace the request",
            "  model/stream         waterfall  around the adapter stream; may yield its own chunks",
            "  tools/pre-execute    waterfall  before a tool runs; may refuse it",
            "  tools/post-execute   waterfall  after a tool runs; may replace the result",
            "  session/event        emit       after an event reaches the session file",
            "",
        ]
        .join("\n");
        assert_eq!(describe_hooks(HOOK_POINTS), expected);
    }
}
