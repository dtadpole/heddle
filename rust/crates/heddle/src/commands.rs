//! Every command, ported from `main`, `runWeb`, `runConfigCommand` and `runCommand` in `src/cli.ts`.
//!
//! Each function takes the parsed [`Args`], the [`Invocation`] and an [`Output`], and returns the
//! [`Exit`] the process ends with. The commands that boot read the booted tree only through
//! [`Services`] and its [`ports`](crate::ports) views, so each one is unit-tested against doubles of
//! those views; a profile that leaves a service out gets the TypeScript build's sentence for it.

use heddle_config::command::{CommandContext, ConfigCommand};

use crate::boot::Boot;
use crate::builtins::BuiltinCatalog;
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
    let command = match args.command {
        Some(CommandWord::Profiles) => ConfigCommand::Profiles,
        _ => ConfigCommand::Config,
    };
    let config_args = crate::cli::config_args(args, &invocation.cwd, &invocation.env);
    let catalog = BuiltinCatalog;
    let context = CommandContext {
        env: &invocation.env,
        cwd: invocation.cwd.clone(),
        catalog: &catalog,
    };
    let (stdout, stderr) = out.writers();
    exit_code(heddle_config::command::run(
        command,
        &config_args,
        &context,
        stdout,
        stderr,
    ))
}

/// A crate command's process exit code as this crate's [`Exit`]: `0` done, anything else the
/// TypeScript build's `process.exitCode = 1`.
fn exit_code(code: i32) -> Exit {
    if code == 0 {
        Exit::Success
    } else {
        Exit::Failure
    }
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
    // The commands that read the working directory (tree, file, session new) land next; until then it
    // is not read here.
    let _ = invocation;
    // A row that failed to load is reported before anything answers: it is the diagnosis a person
    // needs, and the TypeScript build measured it as the worst silence when a broken tree printed a
    // healthy answer and exited 0.
    let failed = crate::boot::failed_entries(boot);
    if !failed.is_empty() {
        let names: Vec<&str> = failed.iter().map(|(id, _)| id.as_str()).collect();
        return out.fail(&format!(
            "{} row(s) failed to load: {}",
            failed.len(),
            names.join(", ")
        ));
    }
    // The allow list is applied once, after every row has had its chance to register, so a plugin's
    // own tool is kept when the configuration names it.
    if let Some(tools) = boot.services.tools() {
        tools.filter_to(&tools.allow_list());
    }
    match args.command {
        Some(CommandWord::Models) => models_command(args, boot, out),
        Some(CommandWord::Tools) => tools_command(args, boot, out),
        Some(CommandWord::Commands) => registered_commands(args, boot, out),
        Some(CommandWord::Sessions) => sessions_command(args, boot, out),
        Some(CommandWord::Transcript) => transcript_command(args, boot, out),
        Some(CommandWord::Hooks) => hooks_command(args, out),
        Some(other) => unported(other.as_str(), out),
        None => unported("the configured tree", out),
    }
}

/// `models`: the configured endpoints, described without their credentials.
fn models_command(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(model) = boot.services.model() else {
        return out.fail("this profile does not load the model plugin");
    };
    let endpoints = model.describe();
    if args.json {
        out.json(&serde_json::Value::Array(endpoints));
        return Exit::Success;
    }
    out.out(&format!("heddle: {} endpoint(s)\n", endpoints.len()));
    for endpoint in &endpoints {
        let credential =
            if endpoint.get("credential").is_some() || endpoint.get("credentialFile").is_some() {
                " credential"
            } else {
                ""
            };
        out.out(&format!(
            "  {:<18} {:<16} {}{credential}\n",
            field(endpoint, "name"),
            field(endpoint, "kind"),
            endpoint
                .get("model")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("-"),
        ));
    }
    Exit::Success
}

/// `tools`: the registered tools, each with the first sentence of its description.
fn tools_command(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(tools) = boot.services.tools() else {
        return out.fail("this profile does not load the tools plugin");
    };
    let described = tools.describe();
    if args.json {
        let records: Vec<serde_json::Value> = described
            .iter()
            .map(|tool| {
                serde_json::json!({
                    "name": field(tool, "name"),
                    "description": field(tool, "description"),
                })
            })
            .collect();
        out.json(&serde_json::Value::Array(records));
        return Exit::Success;
    }
    out.out(&format!("heddle: {} tool(s)\n", described.len()));
    for tool in &described {
        let description = field(tool, "description");
        let first = description.split('.').next().unwrap_or("");
        out.out(&format!("  {:<14} {first}\n", field(tool, "name"),));
    }
    Exit::Success
}

/// `commands`: the commands the tools plugin registered.
fn registered_commands(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(tools) = boot.services.tools() else {
        return out.fail("this profile does not load the tools plugin");
    };
    let described = tools.describe_commands();
    if args.json {
        out.json(&serde_json::Value::Array(described));
        return Exit::Success;
    }
    out.out(&format!("heddle: {} command(s)\n", described.len()));
    for command in &described {
        out.out(&format!(
            "  {:<14} — {}\n",
            field(command, "name"),
            field(command, "description"),
        ));
    }
    Exit::Success
}

/// `sessions`: the store's sessions, newest first, the first twenty.
fn sessions_command(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let sessions = session.list();
    if args.json {
        out.json(&serde_json::Value::Array(sessions));
        return Exit::Success;
    }
    out.out(&format!(
        "heddle: {} session(s) in {}\n",
        sessions.len(),
        session.root().display()
    ));
    for meta in sessions.iter().take(20) {
        out.out(&format!(
            "  {}  {}  turns={}  {}\n",
            field(meta, "id"),
            field(meta, "created"),
            meta.get("turns")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            meta.get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
        ));
    }
    Exit::Success
}

/// `transcript <id>`: the session's events, one compact JSON line each.
fn transcript_command(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(target) = args.target.as_deref() else {
        return out.fail("transcript needs a session id");
    };
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let handle = match session.resume(target) {
        Ok(handle) => handle,
        Err(error) => return out.fail(&error.message),
    };
    let events = match session.events(&handle) {
        Ok(events) => events,
        Err(error) => return out.fail(&error.message),
    };
    for event in &events {
        out.out(&serde_json::to_string(event).unwrap_or_default());
        out.out("\n");
    }
    Exit::Success
}

/// `hooks`: the hook points this build emits.
fn hooks_command(args: &Args, out: &mut Output<'_>) -> Exit {
    if args.json {
        let points: Vec<serde_json::Value> = HOOK_POINTS
            .iter()
            .map(|point| {
                serde_json::json!({
                    "name": point.name,
                    "mode": point.mode,
                    "what": point.what,
                })
            })
            .collect();
        out.json(&serde_json::Value::Array(points));
        return Exit::Success;
    }
    out.out(&describe_hooks(HOOK_POINTS));
    Exit::Success
}

/// A string field of a record, as `String(record.field)` would print it; `-` when absent.
fn field(record: &serde_json::Value, name: &str) -> String {
    match record.get(name) {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(serde_json::Value::Bool(flag)) => flag.to_string(),
        _ => "-".to_owned(),
    }
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
        // `profiles` and `config` are served now and answer through heddle-config; the rest of the
        // command words still say so and exit 2.
        for word in ["web", "models", "hooks", "workspaces"] {
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

    use crate::boot::{Entry, FiberState};
    use crate::ports::{ModelPort, Record, SessionHandle, SessionPort, ToolsPort};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    struct StubModel {
        described: Vec<Record>,
    }

    impl ModelPort for StubModel {
        fn describe(&self) -> Vec<Record> {
            self.described.clone()
        }

        fn names(&self) -> Vec<String> {
            Vec::new()
        }

        fn default_endpoint(&self) -> Option<String> {
            None
        }
    }

    #[derive(Default)]
    struct StubTools {
        described: Vec<Record>,
        commands: Vec<Record>,
        allow: Vec<String>,
        applied: Mutex<Vec<Vec<String>>>,
    }

    impl ToolsPort for StubTools {
        fn describe(&self) -> Vec<Record> {
            self.described.clone()
        }

        fn describe_commands(&self) -> Vec<Record> {
            self.commands.clone()
        }

        fn allow_list(&self) -> Vec<String> {
            self.allow.clone()
        }

        fn filter_to(&self, allow: &[String]) {
            self.applied
                .lock()
                .expect("the stub's lock")
                .push(allow.to_vec());
        }

        fn missing(&self) -> Vec<String> {
            Vec::new()
        }
    }

    struct StubSession {
        root: PathBuf,
        sessions: Vec<Record>,
        events: Vec<Record>,
    }

    impl SessionPort for StubSession {
        fn root(&self) -> PathBuf {
            self.root.clone()
        }

        fn list(&self) -> Vec<Record> {
            self.sessions.clone()
        }

        fn open(&self, _id: &str) -> Option<SessionHandle> {
            unimplemented!("not read by these commands")
        }

        fn resume(&self, id: &str) -> crate::ports::PortResult<SessionHandle> {
            Ok(SessionHandle {
                id: id.to_owned(),
                transcript: self.root.join(format!("{id}.jsonl")),
                inner: Arc::new(()),
            })
        }

        fn current(&self, _cwd: &std::path::Path) -> crate::ports::PortResult<SessionHandle> {
            unimplemented!("not read by these commands")
        }

        fn open_at(
            &self,
            _folder: &std::path::Path,
            _options: crate::ports::OpenAt,
        ) -> crate::ports::PortResult<SessionHandle> {
            unimplemented!("not read by these commands")
        }

        fn create_at(
            &self,
            _branch: &std::path::Path,
            _options: crate::ports::CreateAt,
        ) -> crate::ports::PortResult<(SessionHandle, crate::ports::SessionDefinition)> {
            unimplemented!("not read by these commands")
        }

        fn events(&self, _handle: &SessionHandle) -> crate::ports::PortResult<Vec<Record>> {
            Ok(self.events.clone())
        }

        fn folder(&self, _handle: &SessionHandle) -> Option<PathBuf> {
            None
        }

        fn tree(
            &self,
            _wanted: Option<&std::path::Path>,
            _roots: &[crate::ports::TreeRoot],
            _sessions: &[Record],
            _generated: &[String],
        ) -> crate::ports::PortResult<Record> {
            unimplemented!("not read by these commands")
        }

        fn read_file_text(&self, _path: &std::path::Path) -> crate::ports::PortResult<Record> {
            unimplemented!("not read by these commands")
        }
    }

    fn boot_with(services: Services) -> Boot {
        Boot {
            rows: Vec::new(),
            entries: Vec::new(),
            services,
            anchor: PathBuf::from("/"),
        }
    }

    fn run(boot: &Boot, argv: &[&str]) -> (Exit, String, String) {
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            booted_command(&parsed(argv), &invocation("/work"), boot, &mut out)
        };
        (exit, captured.stdout_text(), captured.stderr_text())
    }

    #[test]
    fn models_prints_the_typescript_table_and_its_json() {
        let mut services = Services::new();
        services.provide(
            "model",
            Arc::new(StubModel {
                described: vec![
                    json!({ "name": "fast", "kind": "openai-chat", "model": "m-1" }),
                    json!({ "name": "local", "kind": "scripted", "credential": true }),
                ],
            }) as Arc<dyn ModelPort>,
        );
        let boot = boot_with(services);
        let (exit, stdout, _) = run(&boot, &["models"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            stdout,
            "heddle: 2 endpoint(s)\n  fast               openai-chat      m-1\n  local              scripted         - credential\n"
        );
        let (_, stdout, _) = run(&boot, &["models", "--json"]);
        // Key order is the map's own (insertion order when `preserve_order` is unified on); the
        // contract is the shape and the values, and the verifiers parse JSON.
        let value: serde_json::Value = serde_json::from_str(&stdout).expect("a JSON array");
        assert_eq!(
            value,
            json!([
                { "name": "fast", "kind": "openai-chat", "model": "m-1" },
                { "name": "local", "kind": "scripted", "credential": true },
            ])
        );
    }

    #[test]
    fn tools_print_the_first_sentence_and_only_name_and_description_with_json() {
        let mut services = Services::new();
        services.provide(
            "tools",
            Arc::new(StubTools {
                described: vec![json!({
                    "name": "write_file",
                    "description": "Write a file. It refuses outside the sandbox.",
                    "parameters": {},
                })],
                ..StubTools::default()
            }) as Arc<dyn ToolsPort>,
        );
        let boot = boot_with(services);
        let (exit, stdout, _) = run(&boot, &["tools"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(stdout, "heddle: 1 tool(s)\n  write_file     Write a file\n");
        let (_, stdout, _) = run(&boot, &["tools", "--json"]);
        let value: serde_json::Value = serde_json::from_str(&stdout).expect("a JSON array");
        assert_eq!(
            value,
            json!([{
                "name": "write_file",
                "description": "Write a file. It refuses outside the sandbox.",
            }]),
            "only the name and the description cross, without the schema"
        );
    }

    #[test]
    fn registered_commands_print_with_an_em_dash() {
        let mut services = Services::new();
        services.provide(
            "tools",
            Arc::new(StubTools {
                commands: vec![json!({ "name": "review", "description": "Review a file" })],
                ..StubTools::default()
            }) as Arc<dyn ToolsPort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["commands"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            stdout,
            "heddle: 1 command(s)\n  review         — Review a file\n"
        );
    }

    #[test]
    fn the_allow_list_is_applied_once_before_a_command_answers() {
        let tools = Arc::new(StubTools {
            allow: vec!["read_file".to_owned()],
            ..StubTools::default()
        });
        let mut services = Services::new();
        services.provide("tools", Arc::clone(&tools) as Arc<dyn ToolsPort>);
        let (exit, _, _) = run(&boot_with(services), &["tools"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            *tools.applied.lock().expect("the stub's lock"),
            vec![vec!["read_file".to_owned()]]
        );
    }

    #[test]
    fn sessions_print_the_store_and_keep_the_order_the_crate_gave() {
        let mut services = Services::new();
        let sessions: Vec<Record> = (1..=21)
            .map(|turn| {
                json!({
                    "id": format!("session-{turn}"),
                    "created": "2026-10-22T20:00:00.000Z",
                    "turns": turn,
                    "title": format!("a session {turn}"),
                })
            })
            .collect();
        services.provide(
            "session",
            Arc::new(StubSession {
                root: PathBuf::from("/var/sessions"),
                sessions,
                events: Vec::new(),
            }) as Arc<dyn SessionPort>,
        );
        let boot = boot_with(services);
        let (exit, stdout, _) = run(&boot, &["sessions"]);
        assert_eq!(exit, Exit::Success);
        let lines: Vec<&str> = stdout.lines().collect();
        assert_eq!(lines[0], "heddle: 21 session(s) in /var/sessions");
        assert_eq!(
            lines[1],
            "  session-1  2026-10-22T20:00:00.000Z  turns=1  a session 1"
        );
        assert_eq!(lines.len(), 21, "one header and the first twenty sessions");
        let (_, json_out, _) = run(&boot, &["sessions", "--json"]);
        let list: serde_json::Value = serde_json::from_str(&json_out).expect("a JSON array");
        assert_eq!(
            list.as_array().map(Vec::len),
            Some(21),
            "the JSON form is not cut to twenty"
        );
        assert_eq!(list[0]["id"], "session-1");
    }

    #[test]
    fn transcript_writes_one_compact_json_line_per_event() {
        let mut services = Services::new();
        services.provide(
            "session",
            Arc::new(StubSession {
                root: PathBuf::from("/var/sessions"),
                sessions: Vec::new(),
                events: vec![
                    json!({ "type": "user/message", "text": "hello" }),
                    json!({ "type": "assistant/completed", "text": "hi" }),
                ],
            }) as Arc<dyn SessionPort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["transcript", "session-7"]);
        assert_eq!(exit, Exit::Success);
        let lines: Vec<&str> = stdout.lines().collect();
        assert_eq!(
            lines.len(),
            2,
            "one line per event, as JSON.stringify writes them"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[0]).expect("a JSON object"),
            json!({ "type": "user/message", "text": "hello" })
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).expect("a JSON object"),
            json!({ "type": "assistant/completed", "text": "hi" })
        );
    }

    #[test]
    fn transcript_needs_a_session_id() {
        let (exit, stdout, stderr) = run(&boot_with(Services::new()), &["transcript"]);
        assert_eq!(exit, Exit::Failure);
        assert_eq!(stdout, "");
        assert_eq!(stderr, "heddle: transcript needs a session id\n");
    }

    #[test]
    fn hooks_print_every_point_in_both_forms() {
        let (exit, stdout, _) = run(&boot_with(Services::new()), &["hooks"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(stdout, describe_hooks(HOOK_POINTS));
        let (_, json_out, _) = run(&boot_with(Services::new()), &["hooks", "--json"]);
        let points: serde_json::Value = serde_json::from_str(&json_out).expect("a JSON array");
        assert_eq!(points.as_array().map(Vec::len), Some(HOOK_POINTS.len()));
        assert_eq!(points[0]["name"], "agent/pre-step");
        assert_eq!(points[5]["mode"], "emit");
    }

    #[test]
    fn a_failed_row_is_reported_before_any_command_answers() {
        let boot = Boot {
            rows: Vec::new(),
            entries: vec![Entry {
                id: "session".to_owned(),
                name: "./src/plugins/session.ts".to_owned(),
                component: crate::builtins::ComponentRef::Unresolved("session".to_owned()),
                requires: Vec::new(),
                state: FiberState::Failed,
                error: None,
            }],
            services: Services::new(),
            anchor: PathBuf::from("/"),
        };
        let (exit, stdout, stderr) = run(&boot, &["sessions"]);
        assert_eq!(exit, Exit::Failure);
        assert_eq!(stdout, "");
        assert_eq!(stderr, "heddle: 1 row(s) failed to load: session\n");
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
