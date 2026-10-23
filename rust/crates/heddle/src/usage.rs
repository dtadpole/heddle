//! The `--help` text, and why it shows only what the binary serves.
//!
//! The verifiers decide whether a part exists by reading `--help`: `05-config-system` looks for
//! `--profile`, `10-llm-backends` for `--endpoint`, `20-streaming` for `--stream`, `30` for `context`,
//! `40` for `tools`, `50` for `--turn`, `60` for `hooks`, `70` for `workspaces` and `sessions`, and the
//! Web UI parts for `web`. A check whose word is absent reports **unjudged** (exit 3) instead of running.
//!
//! So the help is assembled from [`LINES`], each tagged with the [`Capability`] that serves it, and a
//! line is printed only when its capability is served **and** every gate word it contains is served
//! too (`--max-rounds` mentions `web` and `tools`, so it waits for both). A run against a half-ported
//! binary is then unjudged where a capability is missing and judged where it exists, and once every
//! capability is served the text is the TypeScript build's, byte for byte — a unit test holds both.

/// A capability of the binary: one crate wired into the composition, as the help advertises it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    /// Printed whatever is wired: the header, `--help`, `--json`, the bare application's flags.
    Always,
    /// `heddle-config`: `--config`, `--profile`, `--patch`, `profiles`, `config`.
    Config,
    /// `heddle-llm`: `models`, `--endpoint`, `--model`, `--max-output-tokens`.
    Models,
    /// `heddle-llm`'s stream printer: `--stream`.
    Streaming,
    /// `heddle-context`: `context`.
    Context,
    /// `heddle-tools`: `tools`, `commands`.
    Tools,
    /// `heddle-agent`: `--turn`, `--system`, `--max-rounds`, `--resume`, `--new`.
    Turn,
    /// `heddle-events`: `hooks`.
    Hooks,
    /// `heddle-session`: `sessions`, `transcript`, `session new`.
    Sessions,
    /// `heddle-workspace`: `workspaces`, `workspace ...`, `tree`, `file`, `--generated`.
    Workspaces,
    /// `heddle-sandbox`: `--sandbox-root`.
    Sandbox,
    /// `heddle-goal`: `goal`.
    Goal,
    /// `heddle-server`: `web`, `--dry-run`.
    Web,
}

impl Capability {
    /// Every capability, which is what the finished port serves.
    pub const ALL: &'static [Capability] = &[
        Self::Always,
        Self::Config,
        Self::Models,
        Self::Streaming,
        Self::Context,
        Self::Tools,
        Self::Turn,
        Self::Hooks,
        Self::Sessions,
        Self::Workspaces,
        Self::Sandbox,
        Self::Goal,
        Self::Web,
    ];
}

/// What this build serves. Grows by one entry each time a crate is wired and its command answers.
///
/// `Config` is served because `heddle_config::command::run` owns every sentence of `profiles` and
/// `config` and the binary delegates to it; `--profile` in the help is what makes `05-config-system`
/// judge this binary instead of calling the part unjudged. `Sessions`, `Workspaces` and `Goal` are served
/// because `heddle-session`, `heddle-workspace` and `heddle-goal` answer them through their entry points
/// over rows the boot composes; `70-workspaces-sessions` runs 0 failures through them, its web checks
/// unjudged until `web` is served.
pub const SERVED: &[Capability] = &[
    Capability::Always,
    Capability::Config,
    Capability::Sessions,
    Capability::Workspaces,
    Capability::Goal,
    Capability::Web,
    Capability::Turn,
    Capability::Context,
    Capability::Tools,
    Capability::Hooks,
    Capability::Models,
    Capability::Streaming,
];

/// The words the verifiers gate on, and the capability that must be served before one may appear.
pub const GATE_WORDS: &[(&str, Capability)] = &[
    ("--profile", Capability::Config),
    ("--endpoint", Capability::Models),
    ("--stream", Capability::Streaming),
    ("context", Capability::Context),
    ("tools", Capability::Tools),
    ("--turn", Capability::Turn),
    ("hooks", Capability::Hooks),
    ("sessions", Capability::Sessions),
    ("workspaces", Capability::Workspaces),
    ("web", Capability::Web),
];

/// The help, one line per entry, in the TypeScript build's order and spelling.
pub const LINES: &[(&str, Capability)] = &[
    (
        "heddle — a harness and agent framework built on Cordis",
        Capability::Always,
    ),
    ("", Capability::Always),
    ("usage: heddle [options] [command]", Capability::Always),
    ("", Capability::Always),
    ("options:", Capability::Always),
    (
        "  -c, --config <path>        boot from this configuration layer instead of the default profile",
        Capability::Config,
    ),
    (
        "      --profile <name>       boot a named profile from $HEDDLE_HOME/profiles",
        Capability::Config,
    ),
    (
        "      --patch <path>         apply an extra layer after it (repeatable)",
        Capability::Config,
    ),
    (
        "      --dry-run              report what a run would do and stop before doing it",
        Capability::Web,
    ),
    (
        "      --sandbox-root <path>  confine file effects to this directory instead of the working one",
        Capability::Sandbox,
    ),
    (
        "      --turn <text>          run one agent turn and print the answer",
        Capability::Turn,
    ),
    (
        "      --resume <id>          continue an existing session rather than starting one",
        Capability::Turn,
    ),
    (
        "      --new                  start a new session in this folder instead of continuing its own",
        Capability::Turn,
    ),
    (
        "      --generated <name>     a folder a tool writes, so the tree names it as generated (repeatable)",
        Capability::Workspaces,
    ),
    (
        "      --endpoint <name>      which configured endpoint answers (default: the configured default, else the first by name)",
        Capability::Models,
    ),
    (
        "      --model <id>           override the endpoint's model for this turn",
        Capability::Models,
    ),
    (
        "      --system <text>        system prompt, recorded when the session is new",
        Capability::Turn,
    ),
    (
        "      --max-rounds <n>       stop after n model-plus-tools rounds (one-shot default 8; web: uncapped)",
        Capability::Turn,
    ),
    (
        "      --max-output-tokens <n>  cap the tokens one model call may generate",
        Capability::Models,
    ),
    (
        "      --stream               print reasoning and content deltas to stderr as they arrive",
        Capability::Streaming,
    ),
    (
        "      --list                 list what is registered, then stop",
        Capability::Always,
    ),
    (
        "      --json                 print machine-readable output",
        Capability::Always,
    ),
    (
        "  -p, --punctuation <mark>   punctuation the greeting service appends (default !)",
        Capability::Always,
    ),
    (
        "  -t, --target <name>        who the run is for (default heddle)",
        Capability::Always,
    ),
    (
        "  -q, --quiet                do not attach the console exporter",
        Capability::Always,
    ),
    (
        "  -h, --help                 show this message",
        Capability::Always,
    ),
    ("", Capability::Always),
    ("commands:", Capability::Always),
    (
        "  models                     list the configured endpoints, without calling any",
        Capability::Models,
    ),
    (
        "  tools                      list the registered tools",
        Capability::Tools,
    ),
    (
        "  commands                   list the registered commands",
        Capability::Tools,
    ),
    (
        "  sessions                   list the sessions this store holds",
        Capability::Sessions,
    ),
    (
        "  workspaces                 list the workspaces and their sessions",
        Capability::Workspaces,
    ),
    (
        "  workspace add <path> [name]  register a target folder as a workspace root",
        Capability::Workspaces,
    ),
    (
        "  session new [<branch>]     start a session at a branch and write its definition there",
        Capability::Sessions,
    ),
    (
        "  workspace rename <id|path> <name>  retitle a root, leaving its path alone",
        Capability::Workspaces,
    ),
    (
        "  workspace remove <id|path>   unregister a root, reporting where its sessions went",
        Capability::Workspaces,
    ),
    (
        "  tree [<path>]              print one level of the folder tree the left column shows",
        Capability::Workspaces,
    ),
    (
        "  file <path>                print a text file under a workspace root, as the right panel shows it",
        Capability::Workspaces,
    ),
    (
        "  context                    show the assembled context for a session, without calling a model",
        Capability::Context,
    ),
    (
        "  goal [<session-id>]        show the goal a session is working toward",
        Capability::Goal,
    ),
    (
        "  hooks                      list the hook points this build emits",
        Capability::Hooks,
    ),
    (
        "  web                        serve the Web UI on localhost",
        Capability::Web,
    ),
    (
        "  transcript <id>            print a session's transcript",
        Capability::Sessions,
    ),
    (
        "  profiles                   list the profiles this machine holds",
        Capability::Config,
    ),
    (
        "  config                     print the composed tree, or validate it with --validate",
        Capability::Config,
    ),
    (
        "      --validate             with the config command, check every row without starting it",
        Capability::Config,
    ),
    (
        "      --origins              with the config command, show which layer supplied each field",
        Capability::Config,
    ),
    ("", Capability::Always),
    (
        "Endpoint configuration lives outside the repository, in $HEDDLE_CONFIG,",
        Capability::Always,
    ),
    (
        "$HEDDLE_HOME/heddle.json or ~/.heddle/heddle.json. Nothing here carries a URL or a",
        Capability::Always,
    ),
    ("credential of its own.", Capability::Always),
];

/// Whether this build serves `capability`: a command wired to its crate and able to answer.
pub fn served(capability: Capability) -> bool {
    SERVED.contains(&capability)
}

/// Whether a line may be printed when `served` is what the binary serves.
pub fn line_is_served(line: &str, capability: Capability, served: &[Capability]) -> bool {
    served.contains(&capability)
        && GATE_WORDS
            .iter()
            .all(|(word, gate)| !line.contains(word) || served.contains(gate))
}

/// The help for a binary that serves `served`: every served line, each ending in a newline.
pub fn usage(served: &[Capability]) -> String {
    let mut text = String::new();
    for (line, capability) in LINES {
        if line_is_served(line, *capability, served) {
            text.push_str(line);
            text.push('\n');
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `USAGE` template literal of the TypeScript build, read from its source so the two cannot drift.
    fn typescript_usage() -> String {
        let source = include_str!("../../../../src/cli.ts");
        let start = source
            .find("const USAGE = `")
            .expect("src/cli.ts declares USAGE")
            + "const USAGE = `".len();
        let length = source[start..]
            .find('`')
            .expect("USAGE is a closed template literal");
        source[start..start + length].to_owned()
    }

    #[test]
    fn serving_everything_prints_the_typescript_usage_byte_for_byte() {
        assert_eq!(usage(Capability::ALL), typescript_usage());
    }

    #[test]
    fn a_gate_word_appears_only_when_its_capability_is_served() {
        for (word, gate) in GATE_WORDS {
            let without: Vec<Capability> = Capability::ALL
                .iter()
                .copied()
                .filter(|c| c != gate)
                .collect();
            assert!(
                !usage(&without).contains(word),
                "'{word}' leaked into the help without {gate:?}"
            );
            assert!(
                usage(Capability::ALL).contains(word),
                "'{word}' is missing from the full help"
            );
        }
    }

    #[test]
    fn a_config_only_build_is_judged_by_05_and_unjudged_elsewhere() {
        let text = usage(&[Capability::Always, Capability::Config]);
        assert!(
            text.contains("--profile"),
            "05-config-system's gate is open"
        );
        for closed in [
            "--endpoint",
            "--stream",
            "context",
            "tools",
            "--turn",
            "hooks",
            "sessions",
            "workspaces",
            "web",
        ] {
            assert!(
                !text.contains(closed),
                "'{closed}' would open a verifier this build cannot pass"
            );
        }
    }

    #[test]
    fn a_line_waits_for_every_gate_word_it_mentions() {
        let max_rounds = LINES
            .iter()
            .find(|(line, _)| line.contains("--max-rounds"))
            .expect("the line exists");
        assert!(
            !line_is_served(max_rounds.0, max_rounds.1, &[Capability::Turn]),
            "it mentions web and tools"
        );
        assert!(line_is_served(
            max_rounds.0,
            max_rounds.1,
            &[Capability::Turn, Capability::Web, Capability::Tools]
        ));
    }

    #[test]
    fn what_this_build_serves_leaves_every_unported_part_unjudged() {
        let text = usage(SERVED);
        assert!(text.starts_with("heddle — a harness and agent framework built on Cordis\n"));
        for (word, gate) in GATE_WORDS {
            if !SERVED.contains(gate) {
                assert!(
                    !text.contains(word),
                    "'{word}' is advertised before {gate:?} is wired"
                );
            }
        }
    }
}
