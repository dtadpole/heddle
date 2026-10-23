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
use crate::usage::Capability;
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
        // A command that answers is routed whether or not the help advertises it yet: SERVED decides
        // what a verifier may judge, not what the binary does.
        return match command {
            CommandWord::Web => web(args, invocation, out),
            CommandWord::Profiles | CommandWord::Config => config_command(args, invocation, out),
            CommandWord::AdapterCall => adapter_call(out),
            _ => boot_then(args, invocation, out),
        };
    }
    if args.turn.is_some() {
        return turn(args, invocation, out);
    }
    let project_base = invocation.cwd.join(heddle_config::PROJECT_BASE).exists();
    if crate::cli::names_a_tree(args, project_base) {
        configured_tree(args, invocation, out)
    } else {
        bare_application(args, out)
    }
}

/// A run that names a tree and asks for nothing else: boot it, refuse a pending entry or an unmet
/// configuration as the turn does, and print the tree (`printTree` in `src/cli.ts`).
fn configured_tree(args: &Args, invocation: &Invocation, out: &mut Output<'_>) -> Exit {
    let boot = match boot_tree(args, invocation) {
        Ok(boot) => boot,
        Err(message) => return out.fail(&message),
    };
    let exit = print_configured_tree(&boot, out);
    boot.dispose();
    exit
}

fn print_configured_tree(boot: &Boot, out: &mut Output<'_>) -> Exit {
    let pending = crate::boot::settle(boot);
    if !pending.is_empty() {
        out.out(&format!(
            "heddle: {} entry(ies) still pending: {}\n",
            pending.len(),
            pending.join(", ")
        ));
        return Exit::Failure;
    }
    if let Some(tools) = boot.services.tools() {
        tools.filter_to(&tools.allow_list());
    }
    for line in crate::boot::failure_lines(boot) {
        out.err(&format!("{line}\n"));
    }
    let mut problems: Vec<String> = crate::boot::failed_entries(boot)
        .into_iter()
        .map(|(id, name)| format!("row '{id}' ({name}) failed to load"))
        .collect();
    if let Some(tools) = boot.services.tools() {
        problems.extend(tools.missing());
    }
    if !problems.is_empty() {
        return out.fail(&format!(
            "the configuration names {}, which nothing registered",
            problems.join(", ")
        ));
    }
    let entries: Vec<(String, crate::boot::FiberState)> = boot
        .entries
        .iter()
        .map(|entry| (entry.id.clone(), entry.state))
        .collect();
    out.out(&crate::boot::describe_entries(&entries));
    Exit::Success
}

/// The capability a command word belongs to, as the help groups them.
pub fn capability_of(command: CommandWord) -> Capability {
    match command {
        CommandWord::Profiles | CommandWord::Config => Capability::Config,
        CommandWord::AdapterCall => Capability::Always,
        CommandWord::Models => Capability::Models,
        CommandWord::Tools | CommandWord::Commands => Capability::Tools,
        CommandWord::Sessions | CommandWord::Transcript | CommandWord::Session => {
            Capability::Sessions
        }
        CommandWord::Workspaces
        | CommandWord::Workspace
        | CommandWord::Tree
        | CommandWord::File => Capability::Workspaces,
        CommandWord::Hooks => Capability::Hooks,
        CommandWord::Goal => Capability::Goal,
        CommandWord::Context => Capability::Context,
        CommandWord::Web => Capability::Web,
    }
}

/// Boot the tree the command line names, then answer from it: port of `runCommand`'s
/// `bootFromArgs` and `settle`.
fn boot_then(args: &Args, invocation: &Invocation, out: &mut Output<'_>) -> Exit {
    let boot = match boot_tree(args, invocation) {
        Ok(boot) => boot,
        Err(message) => return out.fail(&message),
    };
    let exit = booted_command(args, invocation, &boot, out);
    boot.dispose();
    exit
}

/// The tree the command line names, booted over the built-in catalog: port of `bootFromArgs`.
fn boot_tree(args: &Args, invocation: &Invocation) -> Result<Boot, String> {
    let options = crate::boot::BootOptions {
        layers: crate::cli::layer_options(args, &invocation.cwd, &invocation.env),
        overrides: crate::cli::root_overrides(args, &invocation.cwd)
            .into_iter()
            .collect(),
        target: args.target.clone().unwrap_or_else(|| "heddle".to_owned()),
        env: invocation.env.clone(),
    };
    let catalog = BuiltinCatalog::new(invocation.env.clone(), invocation.cwd.clone());
    crate::boot::boot(&options, &catalog).map_err(|error| error.0)
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
    let catalog = BuiltinCatalog::new(invocation.env.clone(), invocation.cwd.clone());
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
    // A row that failed to load is reported before anything answers: it is the diagnosis a person
    // needs, and the TypeScript build measured it as the worst silence when a broken tree printed a
    // healthy answer and exited 0.
    let failed = crate::boot::failed_entries(boot);
    if !failed.is_empty() {
        for line in crate::boot::failure_lines(boot) {
            out.err(&format!("{line}\n"));
        }
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
        Some(CommandWord::Models) => owned_models(args, invocation, boot, out),
        Some(CommandWord::Tools) => {
            owned_tools(heddle_tools::command::Command::Tools, args, boot, out)
        }
        Some(CommandWord::Commands) => {
            owned_tools(heddle_tools::command::Command::Commands, args, boot, out)
        }
        Some(CommandWord::Sessions) => owned_sessions(
            heddle_session::command::Command::Sessions,
            args,
            invocation,
            boot,
            out,
        ),
        Some(CommandWord::Transcript) => owned_sessions(
            heddle_session::command::Command::Transcript,
            args,
            invocation,
            boot,
            out,
        ),
        Some(CommandWord::Hooks) => owned_hooks(args, out),
        Some(CommandWord::Workspaces) => owned_workspaces(
            heddle_workspace::command::Command::Workspaces,
            args,
            invocation,
            boot,
            out,
        ),
        Some(CommandWord::Workspace) => {
            use crate::cli::Subcommand;
            let command = match args.subcommand {
                Some(Subcommand::List) => heddle_workspace::command::Command::Workspaces,
                Some(Subcommand::Remove) => heddle_workspace::command::Command::WorkspaceRemove,
                Some(Subcommand::Rename) => heddle_workspace::command::Command::WorkspaceRename,
                _ => heddle_workspace::command::Command::WorkspaceAdd,
            };
            owned_workspaces(command, args, invocation, boot, out)
        }
        Some(CommandWord::Tree) => owned_workspaces(
            heddle_workspace::command::Command::Tree,
            args,
            invocation,
            boot,
            out,
        ),
        Some(CommandWord::Session) => owned_workspaces(
            heddle_workspace::command::Command::SessionNew,
            args,
            invocation,
            boot,
            out,
        ),
        Some(CommandWord::File) => owned_workspaces(
            heddle_workspace::command::Command::File,
            args,
            invocation,
            boot,
            out,
        ),
        Some(CommandWord::Goal) => owned_goal(args, invocation, boot, out),
        Some(CommandWord::Context) => owned_context(args, invocation, boot, out),
        Some(other) => unported(other.as_str(), out),
        None => print_configured_tree(boot, out),
    }
}

/// A bare `heddle` with no tree named: the three-plugin application of `src/app.ts` (`console-exporter`
/// unless `-q`, `Greeting`, `announce`), its tree printed, then `heddle/ready` announced, which logs
/// `announce hello, <target><punctuation>` through the console exporter — so `-q` prints no announcement.
pub fn bare_application(args: &Args, out: &mut Output<'_>) -> Exit {
    let mut entries = Vec::new();
    if !args.quiet {
        entries.push((
            "console-exporter".to_owned(),
            crate::boot::FiberState::Active,
        ));
    }
    entries.push(("Greeting".to_owned(), crate::boot::FiberState::Active));
    entries.push(("announce".to_owned(), crate::boot::FiberState::Active));
    out.out(&crate::boot::describe_entries(&entries));
    if !args.quiet {
        let target = args.target.as_deref().unwrap_or("heddle");
        let punctuation = args.punctuation.as_deref().unwrap_or("!");
        out.out(&format!("announce hello, {target}{punctuation}\n"));
    }
    Exit::Success
}

/// `--turn <text>`: the folder's session (or `--resume`'s), its workspace ensured, the turn run, and the
/// answer printed as text or `--json` — `heddle-agent`'s entry point, over the runtime the boot composed.
/// A tree with an entry still pending is refused first, as the TypeScript build's `settle` check does.
pub fn turn(args: &Args, invocation: &Invocation, out: &mut Output<'_>) -> Exit {
    let boot = match boot_tree(args, invocation) {
        Ok(boot) => boot,
        Err(message) => return out.fail(&message),
    };
    let exit = turn_on(args, invocation, &boot, out);
    boot.dispose();
    exit
}

fn turn_on(args: &Args, invocation: &Invocation, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let pending = crate::boot::settle(boot);
    if !pending.is_empty() {
        out.out(&format!(
            "heddle: {} entry(ies) still pending: {}\n",
            pending.len(),
            pending.join(", ")
        ));
        return Exit::Failure;
    }
    // The allow list is applied now, after every row has had its chance to register a tool.
    if let Some(tools) = boot.services.tools() {
        tools.filter_to(&tools.allow_list());
    }
    // The runtime a delegated child or a goal round already shares, else one built for this turn.
    let runtime = match boot
        .services
        .get::<std::sync::Arc<heddle_agent::AgentRuntime>>("agent-runtime")
    {
        Some(runtime) => runtime,
        None => match crate::runtime::agent_runtime(&boot.services) {
            Ok(runtime) => std::sync::Arc::new(runtime),
            Err(message) => return out.fail(&message),
        },
    };
    let (Some(models), Some(sessions)) = (
        boot.services
            .get::<std::sync::Arc<heddle_llm::ModelService>>("model"),
        boot.services
            .get::<std::sync::Arc<heddle_session::SessionService>>("session"),
    ) else {
        return out.fail("this profile does not load the model and session plugins");
    };
    let workspace = boot
        .services
        .get::<std::sync::Arc<heddle_workspace::WorkspaceService>>("workspace");
    let ensure = move |folder: &str| {
        if let Some(workspace) = &workspace {
            let _ = workspace.ensure_owner(folder);
        }
    };
    for line in crate::boot::failure_lines(boot) {
        out.err(&format!("{line}\n"));
    }
    let failed_rows = crate::boot::failed_entries(boot)
        .into_iter()
        .map(|(id, name)| format!("row '{id}' ({name}) failed to load"))
        .collect();
    // `--stream`: the live view of the turn's session, fed by the store's listener (the boot's stream hub).
    let stream_hub = boot
        .services
        .get::<std::sync::Arc<heddle_llm::command::StreamHub>>("stream-hub")
        .unwrap_or_default();
    let starter = move |handle: &heddle_session::SessionHandle| {
        stream_hub.start(&handle.id, Box::new(std::io::stderr()))
            as std::sync::Arc<dyn heddle_agent::command::StreamView>
    };
    // The goal driver, when the profile has one: the one-shot process joins the chain its turn started.
    let goal_advance = boot
        .services
        .get::<std::sync::Arc<heddle_goal::GoalDriver>>("goalDriver")
        .map(|driver| GoalJoin { driver });
    let turn_args = heddle_agent::command::Args {
        turn: args.turn.clone(),
        endpoint: args.endpoint.clone(),
        model: args.model.clone(),
        system: args.system.clone(),
        max_rounds: args.max_rounds,
        max_output_tokens: args.max_output_tokens,
        resume: args.resume.clone(),
        fresh: args.fresh,
        json: args.json,
    };
    let context = heddle_agent::command::Context {
        cwd: invocation.cwd.clone(),
        runtime: &runtime,
        models: &models,
        sessions: &sessions,
        failed_rows,
        ensure_workspace: Some(&ensure),
        stream: args
            .stream
            .then_some(&starter as heddle_agent::command::StreamStarter<'_>),
        goal: goal_advance
            .as_ref()
            .map(|advance| advance as &dyn heddle_agent::command::GoalAdvance),
    };
    let (stdout, stderr) = out.writers();
    let code = crate::runtime::tokio().block_on(heddle_agent::command::run(
        heddle_agent::command::Command::Turn,
        &turn_args,
        &context,
        stdout,
        stderr,
    ));
    exit_code(code)
}

/// The session service the boot registered, or the sentence naming the missing plugin.
fn session_of(boot: &Boot) -> Option<std::sync::Arc<heddle_session::SessionService>> {
    boot.services
        .get::<std::sync::Arc<heddle_session::SessionService>>("session")
}

/// `sessions` and `transcript`: `heddle-session`'s entry point.
fn owned_sessions(
    command: heddle_session::command::Command,
    args: &Args,
    invocation: &Invocation,
    boot: &Boot,
    out: &mut Output<'_>,
) -> Exit {
    let Some(sessions) = session_of(boot) else {
        return out.fail("this profile does not load the session plugin");
    };
    let (stdout, stderr) = out.writers();
    exit_code(heddle_session::command::run(
        command,
        &heddle_session::command::Args {
            target: args.target.clone(),
            json: args.json,
        },
        &heddle_session::command::Context {
            cwd: invocation.cwd.clone(),
            sessions: &sessions,
        },
        stdout,
        stderr,
    ))
}

/// `workspaces`, `workspace add|list|remove|rename`, `tree`, `file`, `session new`: `heddle-workspace`'s
/// entry point. A profile without the workspace row gets the crate's own `requireWorkspace` sentence.
fn owned_workspaces(
    command: heddle_workspace::command::Command,
    args: &Args,
    invocation: &Invocation,
    boot: &Boot,
    out: &mut Output<'_>,
) -> Exit {
    let Some(sessions) = session_of(boot) else {
        return out.fail("this profile does not load the session plugin");
    };
    let workspaces = boot
        .services
        .get::<std::sync::Arc<heddle_workspace::WorkspaceService>>("workspace");
    let (stdout, stderr) = out.writers();
    exit_code(heddle_workspace::command::run(
        command,
        &heddle_workspace::command::Args {
            target: args.target.clone(),
            json: args.json,
            name: args.name.clone(),
            force: args.force,
            generated: args.generated.clone(),
            endpoint: args.endpoint.clone(),
            model: args.model.clone(),
        },
        &heddle_workspace::command::Context {
            cwd: invocation.cwd.clone(),
            sessions: &sessions,
            workspaces: workspaces.as_deref(),
        },
        stdout,
        stderr,
    ))
}

/// The goal driver as the turn joins it: `goalDriver.advance(handle)` in the TypeScript `--turn`.
struct GoalJoin {
    driver: std::sync::Arc<heddle_goal::GoalDriver>,
}

impl heddle_agent::command::GoalAdvance for GoalJoin {
    fn advance<'a>(
        &'a self,
        session: &'a heddle_session::SessionHandle,
    ) -> futures::future::BoxFuture<'a, heddle_agent::command::GoalAdvanced> {
        Box::pin(async move {
            let outcome = self.driver.advance(&session.id).await;
            heddle_agent::command::GoalAdvanced {
                rounds: outcome.rounds,
                stopped: outcome.stopped,
            }
        })
    }
}

/// `adapter-call`: standard input whole as the `{endpoint, request}` value, answered by heddle-llm's entry
/// point on the process runtime. It needs no boot and no service: the endpoint arrives in the input.
fn adapter_call(out: &mut Output<'_>) -> Exit {
    use std::io::Read;
    let mut input = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut input) {
        return out.fail(&format!(
            "adapter-call could not read standard input: {error}"
        ));
    }
    let (stdout, stderr) = out.writers();
    exit_code(
        crate::runtime::tokio().block_on(heddle_llm::command::adapter_call(&input, stdout, stderr)),
    )
}

/// `models`: `heddle-llm`'s entry point over the model row's service.
fn owned_models(args: &Args, invocation: &Invocation, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(service) = boot
        .services
        .get::<std::sync::Arc<heddle_llm::ModelService>>("model")
    else {
        return out.fail("this profile does not load the model plugin");
    };
    let (stdout, stderr) = out.writers();
    exit_code(heddle_llm::command::run(
        heddle_llm::command::Command::Models,
        &heddle_llm::command::Args { json: args.json },
        &heddle_llm::command::Context {
            cwd: invocation.cwd.clone(),
            service: &service,
        },
        stdout,
        stderr,
    ))
}

/// `tools` and `commands`: `heddle-tools`' entry point over the tools row's registry.
fn owned_tools(
    command: heddle_tools::command::Command,
    args: &Args,
    boot: &Boot,
    out: &mut Output<'_>,
) -> Exit {
    let Some(registry) = boot
        .services
        .get::<std::sync::Arc<heddle_tools::ToolRegistry>>("tools")
    else {
        return out.fail("this profile does not load the tools plugin");
    };
    let (stdout, stderr) = out.writers();
    exit_code(heddle_tools::command::run(
        command,
        &heddle_tools::command::Args { json: args.json },
        &heddle_tools::command::Context {
            registry: &registry,
        },
        stdout,
        stderr,
    ))
}

/// `hooks`: `heddle-events`' entry point; the catalog is the build's, so it needs no service.
fn owned_hooks(args: &Args, out: &mut Output<'_>) -> Exit {
    let (stdout, stderr) = out.writers();
    exit_code(heddle_events::command::run(
        heddle_events::command::Command::Hooks,
        &heddle_events::command::Args { json: args.json },
        &heddle_events::command::Context,
        stdout,
        stderr,
    ))
}

/// `goal [<id>]`: `heddle-goal`'s entry point, with the session the positional or the folder names.
fn owned_goal(args: &Args, invocation: &Invocation, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let goals = boot
        .services
        .get::<std::sync::Arc<heddle_goal::GoalService>>("goal");
    let sessions = boot
        .services
        .get::<std::sync::Arc<heddle_session::SessionService>>("session");
    let target = args.target.clone().filter(|target| !target.is_empty());
    let cwd = invocation.cwd.to_string_lossy().into_owned();
    let resolve = move || -> Result<String, String> {
        let sessions = sessions
            .as_ref()
            .ok_or("this profile does not load the session plugin")?;
        let options = match &target {
            Some(id) => heddle_session::StartOptions {
                resume: Some(id.clone()),
                ..heddle_session::StartOptions::default()
            },
            None => heddle_session::StartOptions {
                cwd: Some(cwd.clone()),
                ..heddle_session::StartOptions::default()
            },
        };
        sessions
            .start(options)
            .map(|handle| handle.id.to_string())
            .map_err(|error| error.to_string())
    };
    let (stdout, stderr) = out.writers();
    exit_code(heddle_goal::command::run(
        heddle_goal::command::Command::Goal,
        &heddle_goal::command::Args { json: args.json },
        &heddle_goal::command::Context {
            goals: goals.as_deref(),
            session: &resolve,
        },
        stdout,
        stderr,
    ))
}

/// `context [<id>]`: `heddle-context`'s entry point over the context row's service.
fn owned_context(args: &Args, invocation: &Invocation, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(context) = boot
        .services
        .get::<std::sync::Arc<crate::adapters::Context>>("context")
    else {
        return out.fail("this profile does not load the context plugin");
    };
    let Some(sessions) = boot
        .services
        .get::<std::sync::Arc<heddle_session::SessionService>>("session")
    else {
        return out.fail("this profile does not load the session plugin");
    };
    let tools: Vec<heddle_llm::ToolSpec> = boot
        .services
        .get::<std::sync::Arc<heddle_tools::ToolRegistry>>("tools")
        .map(|registry| registry.describe())
        .unwrap_or_default();
    let workspace_root = boot
        .services
        .sandbox()
        .map(|sandbox| sandbox.workspace_root());
    let (stdout, stderr) = out.writers();
    exit_code(heddle_context::command::run(
        heddle_context::command::Command::Context,
        &heddle_context::command::Args {
            target: args.target.clone(),
            json: args.json,
            endpoint: args.endpoint.clone(),
            model: args.model.clone(),
        },
        &heddle_context::command::Context {
            cwd: invocation.cwd.clone(),
            sessions: &sessions,
            context: &context,
            tools: &tools,
            workspace_root,
        },
        stdout,
        stderr,
    ))
}

/// `web`: boot, settle, then either print the plan (`--dry-run`) or start the server, resume active goals,
/// recover teams, print `heddle web: <url>` and `heddle web: serving on <host>:<port>; pass --port to
/// change it` (and the `--json` line), and serve until SIGINT or SIGTERM.
pub fn web(args: &Args, invocation: &Invocation, out: &mut Output<'_>) -> Exit {
    let boot = match boot_tree(args, invocation) {
        Ok(boot) => boot,
        Err(message) => return out.fail(&message),
    };
    crate::web::web(args, invocation, boot, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::output::Captured;
    use crate::services::Services;
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
    fn a_command_on_a_tree_without_its_row_names_the_missing_plugin() {
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(&parsed(&["models"]), &invocation("/nonexistent"), &mut out)
        };
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            captured.stderr_text(),
            "heddle: this profile does not load the model plugin\n"
        );
    }

    #[test]
    fn a_turn_on_a_tree_without_the_model_row_says_so_and_a_bare_run_names_the_application() {
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--turn", "hello"]),
                &invocation("/nonexistent"),
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            captured.stderr_text(),
            "heddle: this profile does not load the model plugin\n"
        );

        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(&Args::default(), &invocation("/nonexistent"), &mut out)
        };
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            captured.stdout_text(),
            "heddle: 3 plugin(s) loaded\n  console-exporter 1 fiber(s)  active\n  Greeting         \
             1 fiber(s)  active\n  announce         1 fiber(s)  active\nannounce hello, heddle!\n"
        );
    }

    #[test]
    fn a_quiet_bare_run_has_no_exporter_so_nothing_is_announced() {
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["-q", "--punctuation", "?"]),
                &invocation("/nonexistent"),
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            captured.stdout_text(),
            "heddle: 2 plugin(s) loaded\n  Greeting         1 fiber(s)  active\n  announce         \
             1 fiber(s)  active\n"
        );
        let mut captured = Captured::default();
        {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--punctuation", "?"]),
                &invocation("/nonexistent"),
                &mut out,
            );
        }
        assert!(
            captured
                .stdout_text()
                .ends_with("announce hello, heddle?\n")
        );
    }

    #[test]
    fn a_run_that_names_a_tree_prints_the_loaded_rows() {
        let (home, env) = profile_with(
            "tree-print",
            "- insert:\n    - id: approvals\n      name: ./src/approvals/service.ts\n",
        );
        let invocation = Invocation {
            argv: Vec::new(),
            env,
            cwd: home.clone(),
        };
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(&parsed(&["--profile", "dev"]), &invocation, &mut out)
        };
        assert_eq!(exit, Exit::Success, "{}", captured.stderr_text());
        assert_eq!(
            captured.stdout_text(),
            "heddle: 1 plugin(s) loaded\n  approvals        1 fiber(s)  active\n"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    use crate::boot::{Entry, FiberState};
    use crate::ports::{Record, ToolsPort};
    use std::sync::{Arc, Mutex};

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
    fn the_allow_list_is_applied_once_before_a_command_answers() {
        let tools = Arc::new(StubTools {
            allow: vec!["read_file".to_owned()],
            ..StubTools::default()
        });
        let mut services = Services::new();
        services.provide("tools", Arc::clone(&tools) as Arc<dyn ToolsPort>);
        let (_, _, _) = run(&boot_with(services), &["sessions"]);
        assert_eq!(
            *tools.applied.lock().expect("the stub's lock"),
            vec![vec!["read_file".to_owned()]]
        );
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

    /// A profile named `dev` holding the patch that inserts these rows, under a fresh HEDDLE_HOME.
    fn profile_with(label: &str, patch: &str) -> (PathBuf, Env) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let home = std::env::temp_dir().join(format!(
            "heddle-commands-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&home);
        let dir = home.join("profiles").join("dev");
        std::fs::create_dir_all(&dir).expect("the profile directory");
        std::fs::write(dir.join("cordis.yml"), "[]\n").expect("the base layer");
        std::fs::write(dir.join("heddle.patch.yml"), patch).expect("the patch layer");
        let env = Env::from_pairs([
            ("HEDDLE_HOME", home.to_string_lossy().into_owned()),
            ("HOME", home.to_string_lossy().into_owned()),
        ]);
        (home, env)
    }

    #[test]
    fn a_profile_that_names_the_model_row_composes_it_and_models_answers() {
        let script = std::env::temp_dir().join(format!(
            "heddle-commands-script-{}.json",
            std::process::id()
        ));
        std::fs::write(&script, "{\"steps\": []}").expect("the script file");
        let patch = format!(
            "- insert:\n    - id: model\n      name: model\n      config:\n        readLocalConfig: false\n        default: double\n        endpoints:\n          - name: double\n            kind: scripted\n            baseUrl: {}\n            model: scripted\n",
            script.display()
        );
        let (home, env) = profile_with("model", &patch);
        let options = crate::boot::BootOptions {
            layers: heddle_config::LayerOptions {
                profile: Some("dev".to_owned()),
                ..heddle_config::LayerOptions::default()
            },
            overrides: Vec::new(),
            target: "heddle".to_owned(),
            env: env.clone(),
        };
        let catalog = crate::builtins::BuiltinCatalog::new(env, home.clone());
        let boot = crate::boot::boot(&options, &catalog).expect("the profile composes");
        assert_eq!(
            boot.entries
                .iter()
                .map(|entry| entry.state)
                .collect::<Vec<_>>(),
            vec![FiberState::Active],
            "the model row starts, because its adapter exists"
        );
        let (exit, stdout, _) = run(&boot, &["models"]);
        assert_eq!(exit, Exit::Success);
        assert!(stdout.starts_with("heddle: 2 endpoint(s)\n"), "{stdout}");
        assert!(stdout.contains("double"), "{stdout}");
        let (_, json_out, _) = run(&boot, &["models", "--json"]);
        let value: serde_json::Value = serde_json::from_str(&json_out).expect("a JSON array");
        assert_eq!(value.as_array().map(Vec::len), Some(2), "{json_out}");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn every_command_word_belongs_to_the_capability_its_help_line_names() {
        use crate::usage::LINES;
        for (word, command) in [
            ("models", CommandWord::Models),
            ("tools", CommandWord::Tools),
            ("commands", CommandWord::Commands),
            ("sessions", CommandWord::Sessions),
            ("workspaces", CommandWord::Workspaces),
            ("tree", CommandWord::Tree),
            ("file", CommandWord::File),
            ("context", CommandWord::Context),
            ("goal", CommandWord::Goal),
            ("hooks", CommandWord::Hooks),
            ("web", CommandWord::Web),
            ("transcript", CommandWord::Transcript),
            ("profiles", CommandWord::Profiles),
            ("config", CommandWord::Config),
        ] {
            let prefix = format!("  {word} ");
            let (_, capability) = LINES
                .iter()
                .find(|(line, _)| line.starts_with(&prefix))
                .unwrap_or_else(|| panic!("the help has a line for {word}"));
            assert_eq!(capability_of(command), *capability, "{word}");
        }
    }

    #[test]
    fn a_served_booted_command_boots_the_profile_and_answers_from_it() {
        let script = std::env::temp_dir().join(format!(
            "heddle-dispatch-script-{}.json",
            std::process::id()
        ));
        std::fs::write(&script, "{\"steps\": []}").expect("the script file");
        let patch = format!(
            "- insert:\n    - id: model\n      name: model\n      config:\n        readLocalConfig: false\n        endpoints:\n          - name: double\n            kind: scripted\n            baseUrl: {}\n",
            script.display()
        );
        let (home, env) = profile_with("dispatch", &patch);
        let invocation = Invocation {
            argv: Vec::new(),
            env,
            cwd: home.clone(),
        };
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--profile", "dev", "models", "--json"]),
                &invocation,
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Success, "{}", captured.stderr_text());
        let value: serde_json::Value =
            serde_json::from_str(&captured.stdout_text()).expect("a JSON array");
        assert!(
            value
                .as_array()
                .is_some_and(|list| list.iter().any(|endpoint| endpoint["name"] == "double")),
            "{value}"
        );

        // The same command line answers through the default dispatch too: SERVED only decides what
        // the help advertises.
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--profile", "dev", "models"]),
                &invocation,
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Success, "{}", captured.stderr_text());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn a_profile_naming_a_row_with_no_adapter_fails_before_answering() {
        let (home, env) = profile_with(
            "dispatch-unwired",
            "- insert:\n    - id: session\n      name: ./no-such-component.ts\n",
        );
        let invocation = Invocation {
            argv: Vec::new(),
            env,
            cwd: home.clone(),
        };
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--profile", "dev", "sessions"]),
                &invocation,
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Failure);
        // The row's own error first, as the loader logs it, then the summary that refuses the command.
        assert_eq!(
            captured.stderr_text(),
            "session: nothing answers for './no-such-component.ts'; it is neither a built-in nor a \
             component this binary knows\nheddle: 1 row(s) failed to load: session\n"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
