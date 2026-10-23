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
use crate::ports::Record;
use crate::services::Services;
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
    dispatch_serving(args, invocation, out, crate::usage::SERVED)
}

/// [`dispatch`] for a build that serves `served`: the routing itself, separate from what this build
/// serves, so a test can judge a command's whole path before its capability is advertised.
pub fn dispatch_serving(
    args: &Args,
    invocation: &Invocation,
    out: &mut Output<'_>,
    served: &[Capability],
) -> Exit {
    if let Some(command) = args.command {
        let capability = capability_of(command);
        if !served.contains(&capability) {
            return unported(command.as_str(), out);
        }
        return match command {
            CommandWord::Web => web(args, invocation, out),
            CommandWord::Profiles | CommandWord::Config => config_command(args, invocation, out),
            _ => boot_then(args, invocation, out),
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

/// The capability a command word belongs to, as the help groups them.
pub fn capability_of(command: CommandWord) -> Capability {
    match command {
        CommandWord::Profiles | CommandWord::Config => Capability::Config,
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
    let options = crate::boot::BootOptions {
        layers: crate::cli::layer_options(args, &invocation.cwd, &invocation.env),
        overrides: crate::cli::root_overrides(args, &invocation.cwd)
            .into_iter()
            .collect(),
        target: args.target.clone().unwrap_or_else(|| "heddle".to_owned()),
        env: invocation.env.clone(),
    };
    let catalog = BuiltinCatalog::new(invocation.env.clone(), invocation.cwd.clone());
    let boot = match crate::boot::boot(&options, &catalog) {
        Ok(boot) => boot,
        Err(error) => return out.fail(&error.0),
    };
    let exit = booted_command(args, invocation, &boot, out);
    boot.dispose();
    exit
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
        Some(CommandWord::Workspaces) => workspaces_command(args, boot, out),
        Some(CommandWord::Workspace) => workspace_command(args, boot, out),
        Some(CommandWord::Tree) => tree_command(args, boot, out),
        Some(CommandWord::Session) => session_command(args, invocation, boot, out),
        Some(CommandWord::File) => file_command(args, invocation, boot, out),
        Some(CommandWord::Goal) => goal_command(args, invocation, boot, out),
        Some(CommandWord::Context) => context_command(args, invocation, boot, out),
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

/// The workspace service, or the sentence a profile that leaves the plugin out gets.
fn require_workspace(
    boot: &Boot,
) -> Result<std::sync::Arc<dyn crate::ports::WorkspacePort>, String> {
    boot.services.workspace().ok_or_else(|| {
        "this profile does not load the workspace plugin, so it keeps no workspace records"
            .to_owned()
    })
}

/// A canonical absolute path, the spelling the workspace records and the fences compare.
fn canonical(path: &str) -> std::path::PathBuf {
    heddle_config::canonical_path(std::path::Path::new(path))
}

/// `workspaces`, and `workspace list`: the roots with their sessions.
fn workspaces_command(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let workspace = match require_workspace(boot) {
        Ok(workspace) => workspace,
        Err(message) => return out.fail(&message),
    };
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let records = workspace.list();
    let all = session.list();
    if args.json {
        let mut listed = Vec::with_capacity(records.len());
        for record in &records {
            let mut merged = record.clone();
            if let serde_json::Value::Object(map) = &mut merged {
                let ids: Vec<serde_json::Value> = workspace
                    .sessions(record, &all)
                    .iter()
                    .map(|meta| meta.get("id").cloned().unwrap_or(serde_json::Value::Null))
                    .collect();
                map.insert("sessions".to_owned(), serde_json::Value::Array(ids));
            }
            listed.push(merged);
        }
        out.json(&serde_json::Value::Array(listed));
        return Exit::Success;
    }
    out.out(&format!(
        "heddle: {} workspace(s) in {}\n",
        records.len(),
        workspace.file().display()
    ));
    for record in &records {
        let sessions = workspace.sessions(record, &all);
        out.out(&format!(
            "  {}  {}  {} session(s)\n",
            field(record, "title"),
            field(record, "path"),
            sessions.len()
        ));
        for meta in sessions.iter().take(5) {
            out.out(&format!(
                "    {}  turns={}\n",
                field(meta, "id"),
                meta.get("turns")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            ));
        }
    }
    Exit::Success
}

/// `workspace add|list|remove|rename`.
fn workspace_command(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    use crate::cli::Subcommand;
    let Some(target) = args.target.clone() else {
        let missing = match args.subcommand {
            Some(Subcommand::Remove) => "workspace remove needs a workspace id or path",
            Some(Subcommand::Rename) => "workspace rename needs a workspace id or path",
            _ => "workspace add needs a path",
        };
        return out.fail(missing);
    };
    let workspace = match require_workspace(boot) {
        Ok(workspace) => workspace,
        Err(message) => return out.fail(&message),
    };
    match args.subcommand {
        Some(Subcommand::List) => workspaces_command(args, boot, out),
        Some(Subcommand::Remove) => {
            let Some(session) = boot.services.session() else {
                return out.fail("this profile does not load the session plugin");
            };
            let outcome = match workspace.remove(&target, &session.list(), args.force) {
                Ok(outcome) => outcome,
                Err(error) => return out.fail(&error.message),
            };
            if args.json {
                out.json(&outcome);
                return Exit::Success;
            }
            let removed = outcome.get("removed").cloned().unwrap_or_default();
            out.out(&format!(
                "heddle: removed {}  {}\n",
                field(&removed, "title"),
                field(&removed, "path")
            ));
            if let Some(adopted) = outcome.get("adoptedBy").and_then(serde_json::Value::as_str) {
                out.out(&format!(
                    "  {} session(s) adopted by {adopted}\n",
                    outcome
                        .get("ownedSessions")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                ));
            }
            Exit::Success
        }
        Some(Subcommand::Rename) => {
            let renamed = match workspace.rename(&target, args.name.as_deref().unwrap_or("")) {
                Ok(renamed) => renamed,
                Err(error) => return out.fail(&error.message),
            };
            let Some(renamed) = renamed else {
                return out.fail(&format!("no workspace '{target}'"));
            };
            if args.json {
                out.json(&renamed);
                return Exit::Success;
            }
            out.out(&format!(
                "heddle: renamed to {}  {}\n",
                field(&renamed, "title"),
                field(&renamed, "path")
            ));
            Exit::Success
        }
        _ => {
            let (record, created) = match workspace.add(&target, args.name.as_deref()) {
                Ok(added) => added,
                Err(error) => return out.fail(&error.message),
            };
            if args.json {
                let mut merged = record;
                if let serde_json::Value::Object(map) = &mut merged {
                    map.insert("created".to_owned(), serde_json::Value::Bool(created));
                }
                out.json(&merged);
                return Exit::Success;
            }
            out.out(&format!(
                "heddle: {} {}  {}\n",
                if created {
                    "registered"
                } else {
                    "already registered"
                },
                field(&record, "title"),
                field(&record, "path")
            ));
            Exit::Success
        }
    }
}

/// `tree [<path>]`: one level of the folder tree, refused outside every root.
fn tree_command(args: &Args, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let workspace = match require_workspace(boot) {
        Ok(workspace) => workspace,
        Err(message) => return out.fail(&message),
    };
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let wanted = args
        .target
        .as_deref()
        .filter(|target| !target.is_empty())
        .map(canonical);
    if let Some(wanted) = &wanted
        && workspace.owner(wanted).is_none()
    {
        return out.fail(&format!(
            "{} is not under any workspace root; register it with 'heddle workspace add {}'",
            wanted.display(),
            wanted.display()
        ));
    }
    let roots: Vec<crate::ports::TreeRoot> = workspace
        .list()
        .iter()
        .map(|record| crate::ports::TreeRoot {
            path: std::path::PathBuf::from(field(record, "path")),
            title: field(record, "title"),
            origin: record
                .get("origin")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        })
        .collect();
    let mut generated = workspace.generated();
    generated.extend(args.generated.iter().cloned());
    let node = match session.tree(wanted.as_deref(), &roots, &session.list(), &generated) {
        Ok(node) => node,
        Err(error) => return out.fail(&error.message),
    };
    if args.json {
        out.json(&node);
        return Exit::Success;
    }
    for line in describe_tree(&node) {
        out.out(&line);
        out.out("\n");
    }
    Exit::Success
}

/// `tree` as the left column draws it: kind, name, badge, session, one level indented per depth.
fn describe_tree(node: &Record) -> Vec<String> {
    let children = node.get("children").and_then(serde_json::Value::as_array);
    let path = node
        .get("path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let mut lines = vec![format!(
        "heddle: {} node(s) under {}",
        children.map_or(0, Vec::len),
        if path.is_empty() {
            "the workspace level"
        } else {
            path
        }
    )];
    walk_tree(node, 0, &mut lines);
    lines
}

/// One node and everything under it, each child one level deeper.
fn walk_tree(current: &Record, depth: usize, lines: &mut Vec<String>) {
    let badge = match current.get("badge") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(value) => format!(" [{}]", js(value)),
    };
    let session = match current.get("session") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(session) => format!(
            "  session {} ({} turn(s))",
            field(session, "id"),
            session
                .get("turns")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
        ),
    };
    lines.push(format!(
        "  {}{:<9} {}{badge}{session}",
        "  ".repeat(depth),
        field(current, "kind"),
        field(current, "label")
    ));
    if let Some(children) = current
        .get("children")
        .and_then(serde_json::Value::as_array)
    {
        for child in children {
            walk_tree(child, depth + 1, lines);
        }
    }
}

/// `session new [<branch>]`: a session at a branch, its definition written there.
fn session_command(
    args: &Args,
    invocation: &Invocation,
    boot: &Boot,
    out: &mut Output<'_>,
) -> Exit {
    let workspace = match require_workspace(boot) {
        Ok(workspace) => workspace,
        Err(message) => return out.fail(&message),
    };
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let branch = match args.target.as_deref().filter(|target| !target.is_empty()) {
        Some(target) => canonical(target),
        None => heddle_config::canonical_path(&invocation.cwd),
    };
    if let Err(error) = workspace.ensure_owner(&branch) {
        return out.fail(&error.message);
    }
    let (handle, definition) = match session.create_at(
        &branch,
        crate::ports::CreateAt {
            title: args.name.clone(),
            endpoint: args.endpoint.clone(),
            model: args.model.clone(),
        },
    ) {
        Ok(created) => created,
        Err(error) => return out.fail(&error.message),
    };
    if args.json {
        out.json(&serde_json::json!({
            "session": handle.id,
            "name": definition.name,
            "definition": definition.file,
            "log": definition.log,
        }));
        return Exit::Success;
    }
    out.out(&format!(
        "heddle: session {} at {}\n",
        handle.id,
        definition.dir.display()
    ));
    out.out(&format!(
        "heddle: its log is {}\n",
        definition.log.display()
    ));
    Exit::Success
}

/// `file <path>`: a text file under a workspace root, refused outside every root.
fn file_command(args: &Args, _invocation: &Invocation, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(target) = args.target.as_deref() else {
        return out.fail("file needs a path");
    };
    let workspace = match require_workspace(boot) {
        Ok(workspace) => workspace,
        Err(message) => return out.fail(&message),
    };
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let wanted = canonical(target);
    if workspace.owner(&wanted).is_none() {
        return out.fail(&format!(
            "{} is not under any workspace root; register its folder with 'heddle workspace add <path>'",
            wanted.display()
        ));
    }
    let reading = match session.read_file_text(&wanted) {
        Ok(reading) => reading,
        Err(error) => return out.fail(&error.message),
    };
    if args.json {
        out.json(&reading);
        return Exit::Success;
    }
    let text = field(&reading, "text");
    out.out(&text);
    if !text.is_empty() && !text.ends_with('\n') {
        out.out("\n");
    }
    Exit::Success
}

/// `goal [<session-id>]`: what the session works toward.
fn goal_command(args: &Args, invocation: &Invocation, boot: &Boot, out: &mut Output<'_>) -> Exit {
    let Some(goal) = boot.services.goal() else {
        return out.fail("this profile does not load the goal plugin");
    };
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let handle = match args.target.as_deref().filter(|target| !target.is_empty()) {
        Some(target) => session.resume(target),
        None => session.current(&invocation.cwd),
    };
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => return out.fail(&error.message),
    };
    let view = match goal.get(&handle) {
        Ok(view) => view,
        Err(error) => return out.fail(&error.message),
    };
    if args.json {
        out.json(&serde_json::json!({
            "session": handle.id,
            "goal": view.clone().unwrap_or(serde_json::Value::Null),
        }));
        return Exit::Success;
    }
    let Some(view) = view else {
        out.out(&format!("heddle: no goal is current in {}\n", handle.id));
        return Exit::Success;
    };
    out.out(&format!(
        "heddle: {}  revision {}  {} ({})\n",
        field(&view, "id"),
        js(view.get("revision").unwrap_or(&serde_json::Value::Null)),
        field(&view, "phase"),
        field(&view, "activation"),
    ));
    out.out(&format!("  objective: {}\n", field(&view, "objective")));
    out.out(&format!(
        "  rounds: {}/{}\n",
        js(view
            .get("roundsStarted")
            .unwrap_or(&serde_json::Value::Null)),
        js(view
            .get("maxGoalRounds")
            .unwrap_or(&serde_json::Value::Null)),
    ));
    if let Some(blocked) = view.get("blockedReason") {
        out.out(&format!(
            "  blocked: {} — {}\n",
            field(blocked, "code"),
            field(blocked, "message")
        ));
    }
    Exit::Success
}

/// `context [<id>]`: the assembled context, without calling a model.
fn context_command(
    args: &Args,
    invocation: &Invocation,
    boot: &Boot,
    out: &mut Output<'_>,
) -> Exit {
    let Some(context) = boot.services.context() else {
        return out.fail("this profile does not load the context plugin");
    };
    let Some(session) = boot.services.session() else {
        return out.fail("this profile does not load the session plugin");
    };
    let Some(tools) = boot.services.tools() else {
        return out.fail("this profile does not load the tools plugin");
    };
    let handle = match args.target.as_deref().filter(|target| !target.is_empty()) {
        Some(target) => session.resume(target),
        None => session.current(&invocation.cwd),
    };
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => return out.fail(&error.message),
    };
    // The session's own folder is what a run would resolve instructions from; the sandbox root is only
    // a fallback for a record that has none.
    let cwd = session.folder(&handle).or_else(|| {
        boot.services
            .sandbox()
            .map(|sandbox| sandbox.workspace_root())
    });
    let report = match context.assemble(
        &handle,
        crate::ports::AssembleOptions {
            cwd,
            tools: tools.describe(),
            endpoint: args.endpoint.clone(),
            model: args.model.clone(),
        },
    ) {
        Ok(report) => report,
        Err(error) => return out.fail(&error.message),
    };
    let messages = report
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let instructions = report
        .get("instructions")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if args.json {
        out.json(&serde_json::json!({
            "session": handle.id,
            "messageCount": messages.len(),
            "messages": messages,
            "estimatedTokens": report.get("estimatedTokens").cloned().unwrap_or_default(),
            "thresholdTokens": report.get("thresholdTokens").cloned().unwrap_or_default(),
            "contextWindow": report.get("contextWindow").cloned().unwrap_or_default(),
            "pruned": report.get("pruned").cloned().unwrap_or_default(),
            "compacted": report.get("compacted").cloned().unwrap_or_default(),
            "instructions": instructions,
        }));
        return Exit::Success;
    }
    out.out(&format!(
        "heddle: {} message(s), about {} token(s)\n",
        messages.len(),
        js(report
            .get("estimatedTokens")
            .unwrap_or(&serde_json::Value::Null))
    ));
    out.out(&format!(
        "heddle: budget {} of {}; pruned {}; compacted {}\n",
        js(report
            .get("thresholdTokens")
            .unwrap_or(&serde_json::Value::Null)),
        js(report
            .get("contextWindow")
            .unwrap_or(&serde_json::Value::Null)),
        js(report.get("pruned").unwrap_or(&serde_json::Value::Null)),
        js(report.get("compacted").unwrap_or(&serde_json::Value::Null)),
    ));
    for path in &instructions {
        out.out(&format!("  instruction {}\n", js(path)));
    }
    for message in &messages {
        let text = field(message, "text");
        let shortened: String = text.chars().take(80).collect();
        out.out(&format!(
            "  {}: {}\n",
            field(message, "role"),
            shortened.replace('\n', " ")
        ));
    }
    Exit::Success
}

/// A value printed the way JavaScript's `String(value)` prints it.
fn js(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_owned(),
        serde_json::Value::Bool(flag) => flag.to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
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
    use crate::ports::{ModelPort, SessionHandle, SessionPort, ToolsPort};
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
        tree: Option<Record>,
        file_text: Option<String>,
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
            branch: &std::path::Path,
            _options: crate::ports::CreateAt,
        ) -> crate::ports::PortResult<(SessionHandle, crate::ports::SessionDefinition)> {
            Ok((
                SessionHandle {
                    id: "session-1".to_owned(),
                    transcript: self.root.join("session-1.jsonl"),
                    inner: Arc::new(()),
                },
                crate::ports::SessionDefinition {
                    name: "session-1".to_owned(),
                    dir: branch.to_path_buf(),
                    file: branch.join("_sessions_/session-1/session.yml"),
                    log: self.root.join("session-1.jsonl"),
                },
            ))
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
            Ok(self.tree.clone().unwrap_or(serde_json::Value::Null))
        }

        fn read_file_text(&self, path: &std::path::Path) -> crate::ports::PortResult<Record> {
            let Some(text) = &self.file_text else {
                return Err(crate::ports::PortError::new("not a text file"));
            };
            Ok(json!({
                "path": path.to_string_lossy(),
                "name": path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default(),
                "bytes": text.len(),
                "lines": text.lines().count(),
                "text": text,
                "truncated": false,
            }))
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
                tree: None,
                file_text: None,
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
                tree: None,
                file_text: None,
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

    #[derive(Default)]
    struct StubWorkspace {
        file: PathBuf,
        records: Vec<Record>,
        roots: Vec<PathBuf>,
        generated: Vec<String>,
        added: Mutex<Vec<(String, Option<String>)>>,
    }

    impl crate::ports::WorkspacePort for StubWorkspace {
        fn file(&self) -> PathBuf {
            self.file.clone()
        }

        fn list(&self) -> Vec<Record> {
            self.records.clone()
        }

        fn sessions(&self, _record: &Record, all: &[Record]) -> Vec<Record> {
            all.to_vec()
        }

        fn add(&self, path: &str, name: Option<&str>) -> crate::ports::PortResult<(Record, bool)> {
            self.added
                .lock()
                .expect("the stub's lock")
                .push((path.to_owned(), name.map(str::to_owned)));
            Ok((
                json!({ "title": name.unwrap_or(path), "path": path, "origin": "added" }),
                true,
            ))
        }

        fn rename(&self, target: &str, name: &str) -> crate::ports::PortResult<Option<Record>> {
            if target == "missing" {
                return Ok(None);
            }
            Ok(Some(json!({ "title": name, "path": "/work" })))
        }

        fn remove(
            &self,
            _target: &str,
            _all: &[Record],
            _force: bool,
        ) -> crate::ports::PortResult<Record> {
            Ok(json!({
                "removed": { "title": "Old root", "path": "/old" },
                "adoptedBy": "/work",
                "ownedSessions": 3,
            }))
        }

        fn owner(&self, path: &std::path::Path) -> Option<Record> {
            self.roots
                .iter()
                .find(|root| path.starts_with(root))
                .map(|root| json!({ "path": root.to_string_lossy(), "title": "root" }))
        }

        fn ensure_owner(&self, _path: &std::path::Path) -> crate::ports::PortResult<()> {
            Ok(())
        }

        fn generated(&self) -> Vec<String> {
            self.generated.clone()
        }
    }

    struct StubGoal {
        view: Option<Record>,
    }

    impl crate::ports::GoalPort for StubGoal {
        fn get(&self, _handle: &SessionHandle) -> crate::ports::PortResult<Option<Record>> {
            Ok(self.view.clone())
        }
    }

    struct StubContext {
        report: Record,
    }

    impl crate::ports::ContextPort for StubContext {
        fn assemble(
            &self,
            _handle: &SessionHandle,
            _options: crate::ports::AssembleOptions,
        ) -> crate::ports::PortResult<Record> {
            Ok(self.report.clone())
        }
    }

    fn services_with_session(
        sessions: Vec<Record>,
        events: Vec<Record>,
        tree: Option<Record>,
    ) -> Services {
        let mut services = Services::new();
        services.provide(
            "session",
            Arc::new(StubSession {
                root: PathBuf::from("/sessions"),
                sessions,
                events,
                tree,
                file_text: None,
            }) as Arc<dyn SessionPort>,
        );
        services
    }

    #[test]
    fn workspaces_print_each_root_and_its_first_five_sessions() {
        let sessions: Vec<Record> = (1..=6)
            .map(|turn| json!({ "id": format!("s-{turn}"), "turns": turn }))
            .collect();
        let mut services = services_with_session(sessions, Vec::new(), None);
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                records: vec![json!({ "title": "Project", "path": "/work" })],
                roots: vec![PathBuf::from("/work")],
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let boot = boot_with(services);
        let (exit, stdout, _) = run(&boot, &["workspaces"]);
        assert_eq!(exit, Exit::Success);
        let lines: Vec<&str> = stdout.lines().collect();
        assert_eq!(lines[0], "heddle: 1 workspace(s) in /home/ws.json");
        assert_eq!(lines[1], "  Project  /work  6 session(s)");
        assert_eq!(lines[2], "    s-1  turns=1");
        assert_eq!(
            lines.len(),
            7,
            "the header, the root and the first five sessions"
        );
        let (_, json_out, _) = run(&boot, &["workspaces", "--json"]);
        let value: serde_json::Value = serde_json::from_str(&json_out).expect("a JSON array");
        assert_eq!(value[0]["title"], "Project");
        assert_eq!(
            value[0]["sessions"].as_array().map(Vec::len),
            Some(6),
            "the JSON form carries every session id"
        );
    }

    #[test]
    fn workspace_add_prints_whether_the_root_was_new() {
        let mut services = services_with_session(Vec::new(), Vec::new(), None);
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, stdout, _) = run(
            &boot_with(services),
            &["workspace", "add", "/work", "Project"],
        );
        assert_eq!(exit, Exit::Success);
        assert_eq!(stdout, "heddle: registered Project  /work\n");
    }

    #[test]
    fn workspace_rename_names_what_it_could_not_find() {
        let mut services = services_with_session(Vec::new(), Vec::new(), None);
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, _, stderr) = run(
            &boot_with(services),
            &["workspace", "rename", "missing", "New"],
        );
        assert_eq!(exit, Exit::Failure);
        assert_eq!(stderr, "heddle: no workspace 'missing'\n");
    }

    #[test]
    fn workspace_remove_reports_the_adoption() {
        let mut services = services_with_session(Vec::new(), Vec::new(), None);
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["workspace", "remove", "/old"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            stdout,
            "heddle: removed Old root  /old\n  3 session(s) adopted by /work\n"
        );
    }

    #[test]
    fn workspaces_needs_the_workspace_plugin() {
        let (exit, _, stderr) = run(
            &boot_with(services_with_session(Vec::new(), Vec::new(), None)),
            &["workspaces"],
        );
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            stderr,
            "heddle: this profile does not load the workspace plugin, so it keeps no workspace records\n"
        );
    }

    #[test]
    fn tree_refuses_a_path_outside_every_root() {
        let mut services = services_with_session(Vec::new(), Vec::new(), None);
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                records: vec![json!({ "title": "Project", "path": "/work" })],
                roots: vec![PathBuf::from("/work")],
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, _, stderr) = run(&boot_with(services), &["tree", "/elsewhere"]);
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            stderr,
            "heddle: /elsewhere is not under any workspace root; register it with 'heddle workspace add /elsewhere'\n"
        );
    }

    #[test]
    fn tree_prints_the_left_column() {
        let node = json!({
            "path": "/work",
            "kind": "root",
            "label": "Project",
            "badge": null,
            "session": null,
            "children": [
                {
                    "path": "/work/notes.md",
                    "kind": "file",
                    "label": "notes.md",
                    "badge": null,
                    "session": { "id": "s-1", "turns": 2 },
                },
                {
                    "path": "/work/dist",
                    "kind": "folder",
                    "label": "dist",
                    "badge": "generated",
                    "session": null,
                },
            ],
        });
        let mut services = services_with_session(Vec::new(), Vec::new(), Some(node));
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                records: vec![json!({ "title": "Project", "path": "/work" })],
                roots: vec![PathBuf::from("/work")],
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["tree"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            stdout,
            "heddle: 2 node(s) under /work\n  root      Project\n    file      notes.md  session s-1 (2 turn(s))\n    folder    dist [generated]\n"
        );
    }

    #[test]
    fn file_prints_the_text_and_adds_a_newline_only_when_it_is_missing() {
        let mut services = Services::new();
        services.provide(
            "session",
            Arc::new(StubSession {
                root: PathBuf::from("/sessions"),
                sessions: Vec::new(),
                events: Vec::new(),
                tree: None,
                file_text: Some("one line".to_owned()),
            }) as Arc<dyn SessionPort>,
        );
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                records: vec![json!({ "title": "Project", "path": "/work" })],
                roots: vec![PathBuf::from("/work")],
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["file", "/work/notes.md"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(stdout, "one line\n");
    }

    #[test]
    fn file_refuses_a_path_outside_every_root() {
        let mut services = Services::new();
        services.provide(
            "session",
            Arc::new(StubSession {
                root: PathBuf::from("/sessions"),
                sessions: Vec::new(),
                events: Vec::new(),
                tree: None,
                file_text: None,
            }) as Arc<dyn SessionPort>,
        );
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                roots: vec![PathBuf::from("/work")],
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, _, stderr) = run(&boot_with(services), &["file", "/etc/hosts"]);
        assert_eq!(exit, Exit::Failure);
        // The path is canonicalised first (`/etc` is `/private/etc` on macOS), so the sentence names
        // the resolved path; the fence and its sentence are what the check asserts.
        assert!(
            stderr.ends_with("is not under any workspace root; register its folder with 'heddle workspace add <path>'\n"),
            "{stderr}"
        );
    }

    #[test]
    fn session_new_reports_where_the_definition_and_the_log_are() {
        let mut services = Services::new();
        services.provide(
            "session",
            Arc::new(StubSession {
                root: PathBuf::from("/sessions"),
                sessions: Vec::new(),
                events: Vec::new(),
                tree: None,
                file_text: None,
            }) as Arc<dyn SessionPort>,
        );
        services.provide(
            "workspace",
            Arc::new(StubWorkspace {
                file: PathBuf::from("/home/ws.json"),
                ..StubWorkspace::default()
            }) as Arc<dyn crate::ports::WorkspacePort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["session", "new", "/work"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            stdout,
            "heddle: session session-1 at /work\nheddle: its log is /sessions/session-1.jsonl\n"
        );
    }

    #[test]
    fn goal_prints_the_view_and_its_rounds() {
        let mut services = services_with_session(Vec::new(), Vec::new(), None);
        services.provide(
            "goal",
            Arc::new(StubGoal {
                view: Some(json!({
                    "id": "goal-1",
                    "revision": 2,
                    "phase": "active",
                    "activation": "armed",
                    "objective": "ship the binary",
                    "roundsStarted": 3,
                    "maxGoalRounds": 256,
                })),
            }) as Arc<dyn crate::ports::GoalPort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["goal", "s-1"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            stdout,
            "heddle: goal-1  revision 2  active (armed)\n  objective: ship the binary\n  rounds: 3/256\n"
        );
    }

    #[test]
    fn goal_says_when_no_goal_is_current() {
        let mut services = services_with_session(Vec::new(), Vec::new(), None);
        services.provide(
            "goal",
            Arc::new(StubGoal { view: None }) as Arc<dyn crate::ports::GoalPort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["goal", "s-1"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(stdout, "heddle: no goal is current in s-1\n");
    }

    #[test]
    fn context_prints_the_report_and_its_messages() {
        let mut services = services_with_session(Vec::new(), Vec::new(), None);
        services.provide(
            "tools",
            Arc::new(StubTools {
                described: vec![json!({ "name": "read_file", "description": "Read" })],
                ..StubTools::default()
            }) as Arc<dyn ToolsPort>,
        );
        services.provide(
            "context",
            Arc::new(StubContext {
                report: json!({
                    "messages": [
                        { "role": "user", "text": "hello there" },
                        { "role": "assistant", "text": "hi" },
                    ],
                    "estimatedTokens": 12,
                    "thresholdTokens": 1000,
                    "contextWindow": 8000,
                    "pruned": false,
                    "compacted": 0,
                    "instructions": ["/work/AGENTS.md"],
                }),
            }) as Arc<dyn crate::ports::ContextPort>,
        );
        let (exit, stdout, _) = run(&boot_with(services), &["context", "s-1"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(
            stdout,
            "heddle: 2 message(s), about 12 token(s)\nheddle: budget 1000 of 8000; pruned false; compacted 0\n  instruction /work/AGENTS.md\n  user: hello there\n  assistant: hi\n"
        );
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
        let served = [Capability::Always, Capability::Config, Capability::Models];
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch_serving(
                &parsed(&["--profile", "dev", "models", "--json"]),
                &invocation,
                &mut out,
                &served,
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

        // The same command line, not served, still says so and exits 2.
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch(
                &parsed(&["--profile", "dev", "models"]),
                &invocation,
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Unported);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn a_profile_naming_a_row_with_no_adapter_fails_before_answering() {
        let (home, env) = profile_with(
            "dispatch-unwired",
            "- insert:\n    - id: session\n      name: ./src/plugins/session.ts\n",
        );
        let invocation = Invocation {
            argv: Vec::new(),
            env,
            cwd: home.clone(),
        };
        let mut captured = Captured::default();
        let exit = {
            let mut out = captured.output();
            dispatch_serving(
                &parsed(&["--profile", "dev", "sessions"]),
                &invocation,
                &mut out,
                &[Capability::Always, Capability::Config, Capability::Sessions],
            )
        };
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            captured.stderr_text(),
            "heddle: 1 row(s) failed to load: session\n"
        );
        let _ = std::fs::remove_dir_all(&home);
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
