//! `heddle workspaces`, `workspace add|list|remove|rename`, `tree`, `file` and `session new`: the
//! workspace commands, answered by the crate that owns them (D-043).
//!
//! Ported from `src/cli.ts` (the `workspaces`, `workspace`, `tree`, `session` and `file` branches, and
//! `describeTree`). The binary parses its command line, boots the profile, builds the
//! [`WorkspaceService`] and the [`SessionService`] from their rows, and calls [`run`] with the flags this
//! crate reads.
//!
//! `session new` is answered here rather than in `heddle_session::command` because it registers the
//! branch's workspace root before it creates the session, so it needs both services, and the session crate
//! cannot depend on this one.
//!
//! # Contract
//!
//! - Exit `0` when the command answered; `1` with `heddle: <sentence>` on `err` when it refused. Never `2`.
//! - `--json` is `JSON.stringify(value, null, 2)` plus a newline; text is `src/cli.ts`'s, byte for byte.
//! - A path argument is resolved against [`Context::cwd`], never the process's directory, then made
//!   canonical, so `tree` and `file` judge the path a symlink resolves to.
//! - The fence is the TypeScript build's: `tree` and `file` refuse a path under no workspace root.

use std::io::Write;
use std::path::{Path, PathBuf};

use heddle_config::canonical_path;
use heddle_session::command::{refuse, write_pretty};
use heddle_session::{CreateAtOptions, SessionService};
use serde_json::Value;

use crate::file::read_file_text;
use crate::record::listing_row;
use crate::service::WorkspaceService;
use crate::tree::{ArchivedFilter, TreeInput, TreeNode, TreeRoot, tree};

/// The command words this crate answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// `heddle workspaces` and `heddle workspace list`: the roots and the sessions each accounts for.
    Workspaces,
    /// `heddle workspace add <path> [--name <title>]`.
    WorkspaceAdd,
    /// `heddle workspace remove <id|path> [--force]`.
    WorkspaceRemove,
    /// `heddle workspace rename <id|path> --name <title>`.
    WorkspaceRename,
    /// `heddle tree [<path>] [--generated <name>]...`: one level of the folder tree.
    Tree,
    /// `heddle file <path>`: a text file under a root.
    File,
    /// `heddle session new [<branch>] [--name] [--endpoint] [--model]`: a session and its definition.
    SessionNew,
}

/// The flags these commands read, named after the TypeScript `Args` fields.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Args {
    /// The positional: a path, a workspace id or path, or a branch.
    pub target: Option<String>,
    /// `--json`.
    pub json: bool,
    /// `--name`: a workspace's title, or a new session's.
    pub name: Option<String>,
    /// `--force`: remove a root that still holds sessions with nothing above it.
    pub force: bool,
    /// `--generated <name>`, repeatable: folder names a tool writes, added to the profile's.
    pub generated: Vec<String>,
    /// `--endpoint`, recorded on a new session.
    pub endpoint: Option<String>,
    /// `--model`, recorded on a new session.
    pub model: Option<String>,
}

/// What a command runs against: the services the boot built from the session and workspace rows, and
/// the directory the run was started in. `workspaces` is `None` when the profile loads no workspace row.
pub struct Context<'a> {
    pub cwd: PathBuf,
    pub sessions: &'a SessionService,
    pub workspaces: Option<&'a WorkspaceService>,
}

/// Answer `command`, writing the answer to `out` and any refusal to `err`; return the exit code.
pub fn run(
    command: Command,
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command {
        Command::Workspaces => workspaces(args, context, out, err),
        Command::WorkspaceAdd => workspace_add(args, context, out, err),
        Command::WorkspaceRemove => workspace_remove(args, context, out, err),
        Command::WorkspaceRename => workspace_rename(args, context, out, err),
        Command::Tree => tree_command(args, context, out, err),
        Command::File => file_command(args, context, out, err),
        Command::SessionNew => session_new(args, context, out, err),
    }
}

/// `requireWorkspace` in `src/cli.ts`.
const NO_WORKSPACE: &str =
    "this profile does not load the workspace plugin, so it keeps no workspace records";

/// A path argument resolved against the run's directory, then canonical — `canonicalPath(target)`.
fn canonical_in(cwd: &Path, target: &str) -> String {
    let path = Path::new(target);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    canonical_path(&joined).to_string_lossy().into_owned()
}

/// An id-or-path argument: an id the record holds is kept as written; anything else is a path,
/// resolved against the run's directory.
fn id_or_path(workspaces: &WorkspaceService, cwd: &Path, target: &str) -> String {
    if workspaces.read().workspaces.contains_key(target) {
        target.to_string()
    } else {
        canonical_in(cwd, target)
    }
}

fn record_value(record: &crate::record::WorkspaceRecord) -> Value {
    serde_json::to_value(record).unwrap_or(Value::Null)
}

/// `heddle workspaces` / `workspace list`.
fn workspaces(args: &Args, context: &Context<'_>, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let Some(workspaces) = context.workspaces else {
        return refuse(err, NO_WORKSPACE);
    };
    let records = workspaces.list();
    let all = context.sessions.list();
    if args.json {
        let rows: Vec<Value> = records
            .iter()
            .map(|record| listing_row(record, &workspaces.sessions(record, &all)))
            .collect();
        write_pretty(out, &Value::Array(rows));
        return 0;
    }
    let _ = writeln!(
        out,
        "heddle: {} workspace(s) in {}",
        records.len(),
        workspaces.file()
    );
    for record in &records {
        let owned = workspaces.sessions(record, &all);
        let _ = writeln!(
            out,
            "  {}  {}  {} session(s)",
            record.title,
            record.path,
            owned.len()
        );
        for meta in owned.iter().take(5) {
            let _ = writeln!(out, "    {}  turns={}", meta.id(), meta.turns());
        }
    }
    0
}

/// `heddle workspace add <path>`.
fn workspace_add(
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let Some(target) = args.target.as_deref() else {
        return refuse(err, "workspace add needs a path");
    };
    let Some(workspaces) = context.workspaces else {
        return refuse(err, NO_WORKSPACE);
    };
    let addition = match workspaces.add(&canonical_in(&context.cwd, target), args.name.as_deref()) {
        Ok(addition) => addition,
        Err(error) => return refuse(err, error),
    };
    if args.json {
        // `{ ...record, created }`
        let mut value = record_value(&addition.record);
        if let Value::Object(map) = &mut value {
            map.insert("created".to_string(), Value::Bool(addition.created));
        }
        write_pretty(out, &value);
    } else {
        let _ = writeln!(
            out,
            "heddle: {} {}  {}",
            if addition.created {
                "registered"
            } else {
                "already registered"
            },
            addition.record.title,
            addition.record.path
        );
    }
    0
}

/// `heddle workspace remove <id|path> [--force]`.
fn workspace_remove(
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let Some(target) = args.target.as_deref() else {
        return refuse(err, "workspace remove needs a workspace id or path");
    };
    let Some(workspaces) = context.workspaces else {
        return refuse(err, NO_WORKSPACE);
    };
    let target = id_or_path(workspaces, &context.cwd, target);
    let removal = match workspaces.remove(&target, &context.sessions.list(), args.force) {
        Ok(removal) => removal,
        Err(error) => return refuse(err, error),
    };
    if args.json {
        write_pretty(out, &serde_json::to_value(&removal).unwrap_or(Value::Null));
    } else {
        let _ = writeln!(
            out,
            "heddle: removed {}  {}",
            removal.removed.title, removal.removed.path
        );
        if let Some(adopted_by) = &removal.adopted_by {
            let _ = writeln!(
                out,
                "  {} session(s) adopted by {adopted_by}",
                removal.owned_sessions
            );
        }
    }
    0
}

/// `heddle workspace rename <id|path> --name <title>`.
fn workspace_rename(
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    // The TypeScript build checks the positional once for `add` and `rename` alike, so a rename without
    // one is refused with the add sentence; kept, because the verifiers read the sentence.
    let Some(target) = args.target.as_deref() else {
        return refuse(err, "workspace add needs a path");
    };
    let Some(workspaces) = context.workspaces else {
        return refuse(err, NO_WORKSPACE);
    };
    let target = id_or_path(workspaces, &context.cwd, target);
    let renamed = match workspaces.rename(&target, args.name.as_deref().unwrap_or("")) {
        Ok(Some(renamed)) => renamed,
        Ok(None) => {
            return refuse(
                err,
                format!("no workspace '{}'", args.target.as_deref().unwrap_or("")),
            );
        }
        Err(error) => return refuse(err, error),
    };
    if args.json {
        write_pretty(out, &record_value(&renamed));
    } else {
        let _ = writeln!(
            out,
            "heddle: renamed to {}  {}",
            renamed.title, renamed.path
        );
    }
    0
}

/// `heddle tree [<path>]`.
fn tree_command(
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let wanted = args
        .target
        .as_deref()
        .filter(|target| !target.is_empty())
        .map(|target| canonical_in(&context.cwd, target));
    let Some(workspaces) = context.workspaces else {
        return refuse(err, NO_WORKSPACE);
    };
    // A path outside every root is refused rather than walked: the tree is a view of the folders a person
    // registered, not a listing of the machine.
    if let Some(path) = &wanted
        && workspaces.owner(path).is_none()
    {
        return refuse(
            err,
            format!(
                "{path} is not under any workspace root; register it with 'heddle workspace add {path}'"
            ),
        );
    }
    let mut generated = workspaces.generated().to_vec();
    generated.extend(args.generated.iter().cloned());
    let input = TreeInput {
        roots: workspaces.list().iter().map(TreeRoot::from).collect(),
        sessions: context.sessions.list(),
        generated,
        archived: ArchivedFilter::Hide,
    };
    let node = tree(wanted.as_deref(), &input);
    if args.json {
        write_pretty(out, &serde_json::to_value(&node).unwrap_or(Value::Null));
    } else {
        let _ = writeln!(out, "{}", describe_tree(&node).join("\n"));
    }
    0
}

/// `describeTree` in `src/cli.ts`: a header, then the node and its children, indented two spaces a level,
/// each line `kind` padded to nine, the label, the type badge in brackets, and the session with its turns.
pub fn describe_tree(node: &TreeNode) -> Vec<String> {
    let count = node.children.as_ref().map(Vec::len).unwrap_or(0);
    let under = if node.path.is_empty() {
        "the workspace level".to_string()
    } else {
        node.path.clone()
    };
    let mut lines = vec![format!("heddle: {count} node(s) under {under}")];
    fn walk(current: &TreeNode, depth: usize, lines: &mut Vec<String>) {
        let kind = serde_json::to_value(current.kind)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        let badge = current
            .badge
            .as_ref()
            .map(|badge| format!(" [{badge}]"))
            .unwrap_or_default();
        let session = current
            .session
            .as_ref()
            .map(|session| format!("  session {} ({} turn(s))", session.id, session.turns))
            .unwrap_or_default();
        lines.push(format!(
            "  {}{kind:<9} {}{badge}{session}",
            "  ".repeat(depth),
            current.label
        ));
        for child in current.children.iter().flatten() {
            walk(child, depth + 1, lines);
        }
    }
    walk(node, 0, &mut lines);
    lines
}

/// `heddle file <path>`.
fn file_command(
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let Some(target) = args.target.as_deref() else {
        return refuse(err, "file needs a path");
    };
    let wanted = canonical_in(&context.cwd, target);
    let Some(workspaces) = context.workspaces else {
        return refuse(err, NO_WORKSPACE);
    };
    // The same fence as the tree, judged on the canonical path, so a symlink that resolves outside every
    // root is refused rather than followed.
    if workspaces.owner(&wanted).is_none() {
        return refuse(
            err,
            format!(
                "{wanted} is not under any workspace root; register its folder with 'heddle workspace add <path>'"
            ),
        );
    }
    let reading = match read_file_text(&wanted, None) {
        Ok(reading) => reading,
        Err(error) => return refuse(err, error),
    };
    if args.json {
        write_pretty(out, &serde_json::to_value(&reading).unwrap_or(Value::Null));
    } else if reading.text.is_empty() || reading.text.ends_with('\n') {
        let _ = write!(out, "{}", reading.text);
    } else {
        let _ = writeln!(out, "{}", reading.text);
    }
    0
}

/// `heddle session new [<branch>]`.
fn session_new(
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let branch = match args.target.as_deref().filter(|target| !target.is_empty()) {
        Some(target) => canonical_in(&context.cwd, target),
        None => canonical_path(&context.cwd).to_string_lossy().into_owned(),
    };
    let Some(workspaces) = context.workspaces else {
        return refuse(err, NO_WORKSPACE);
    };
    // Registering the branch's owner keeps "a session always has a workspace" true for a session created
    // before anything has run there.
    if let Err(error) = workspaces.ensure_owner(&branch) {
        return refuse(err, error);
    }
    let created = match context.sessions.create_at(
        &branch,
        CreateAtOptions {
            title: args.name.clone(),
            endpoint: args.endpoint.clone(),
            model: args.model.clone(),
            reasoning_effort: None,
            preset: None,
        },
    ) {
        Ok(created) => created,
        Err(error) => return refuse(err, error),
    };
    if args.json {
        write_pretty(
            out,
            &serde_json::json!({
                "session": created.handle.id,
                "name": created.definition.name,
                "definition": created.definition.file,
                "log": created.definition.log,
            }),
        );
    } else {
        let _ = writeln!(
            out,
            "heddle: session {} at {}",
            created.handle.id, created.definition.dir
        );
        let _ = writeln!(out, "heddle: its log is {}", created.definition.log);
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use heddle_config::Env;
    use heddle_session::{OpenAtOptions, SessionConfig};

    /// A store and a record file in one temporary home, the shape the verifier's checks boot.
    struct Home {
        dir: tempfile::TempDir,
        sessions: SessionService,
        workspaces: WorkspaceService,
    }

    impl Home {
        fn new() -> Home {
            let dir = tempfile::tempdir().unwrap();
            let sessions = SessionService::new(
                &SessionConfig {
                    root: Some(dir.path().join("sessions").to_string_lossy().into_owned()),
                },
                &Env::default(),
                None,
            );
            let workspaces = WorkspaceService::new(
                &crate::service::WorkspaceConfig {
                    file: Some(
                        dir.path()
                            .join("workspaces.json")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    generated: vec!["dist".to_string()],
                },
                &Env::default(),
            );
            Home {
                dir,
                sessions,
                workspaces,
            }
        }

        /// A folder under the home, created, as its canonical path.
        fn folder(&self, relative: &str) -> String {
            let path = self.dir.path().join(relative);
            std::fs::create_dir_all(&path).unwrap();
            canonical_path(&path).to_string_lossy().into_owned()
        }

        fn run(&self, command: Command, args: Args) -> (i32, String, String) {
            self.run_with(command, args, Some(&self.workspaces), self.dir.path())
        }

        fn run_with(
            &self,
            command: Command,
            args: Args,
            workspaces: Option<&WorkspaceService>,
            cwd: &Path,
        ) -> (i32, String, String) {
            let context = Context {
                cwd: cwd.to_path_buf(),
                sessions: &self.sessions,
                workspaces,
            };
            let mut out = Vec::new();
            let mut err = Vec::new();
            let code = run(command, &args, &context, &mut out, &mut err);
            (
                code,
                String::from_utf8(out).unwrap(),
                String::from_utf8(err).unwrap(),
            )
        }
    }

    fn json() -> Args {
        Args {
            json: true,
            ..Args::default()
        }
    }

    fn target(target: &str) -> Args {
        Args {
            target: Some(target.to_string()),
            ..Args::default()
        }
    }

    #[test]
    fn workspace_add_answers_the_record_and_whether_it_was_created() {
        let home = Home::new();
        let work = home.folder("work");
        let (code, out, err) = home.run(
            Command::WorkspaceAdd,
            Args {
                json: true,
                ..target(&work)
            },
        );
        assert_eq!((code, err.as_str()), (0, ""));
        let value: Value = serde_json::from_str(&out).unwrap();
        // `{ ...record, created }`, in that order.
        assert_eq!(
            value.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "id",
                "path",
                "title",
                "origin",
                "createdAt",
                "updatedAt",
                "created"
            ]
        );
        assert_eq!(value["path"], work.as_str());
        assert_eq!(value["created"], true);

        let (_, text, _) = home.run(Command::WorkspaceAdd, target(&work));
        assert_eq!(text, format!("heddle: already registered work  {work}\n"));
    }

    #[test]
    fn a_relative_path_is_resolved_against_the_runs_directory_not_the_process() {
        let home = Home::new();
        let work = home.folder("work");
        let (code, out, _) = home.run_with(
            Command::WorkspaceAdd,
            target("work"),
            Some(&home.workspaces),
            home.dir.path(),
        );
        assert_eq!(code, 0);
        assert_eq!(out, format!("heddle: registered work  {work}\n"));
    }

    #[test]
    fn workspaces_lists_each_root_with_the_sessions_it_accounts_for() {
        let home = Home::new();
        let work = home.folder("work");
        let deeper = home.folder("work/nested/deeper");
        home.run(Command::WorkspaceAdd, target(&work));
        let session = home
            .sessions
            .open_at(&deeper, OpenAtOptions::default())
            .unwrap();
        home.sessions.user(&session, "a turn", None).unwrap();

        let (code, out, _) = home.run(Command::Workspaces, json());
        assert_eq!(code, 0);
        let rows: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(rows[0]["path"], work.as_str());
        assert_eq!(rows[0]["sessions"], serde_json::json!([session.id]));

        let (_, text, _) = home.run(Command::Workspaces, Args::default());
        assert_eq!(
            text,
            format!(
                "heddle: 1 workspace(s) in {}\n  work  {work}  1 session(s)\n    {}  turns=1\n",
                home.workspaces.file(),
                session.id
            )
        );
    }

    #[test]
    fn workspace_remove_refuses_a_root_that_still_holds_sessions_and_says_where_they_went() {
        let home = Home::new();
        let parent = home.folder("parent");
        let child = home.folder("parent/child");
        home.run(Command::WorkspaceAdd, target(&child));
        home.sessions
            .open_at(&child, OpenAtOptions::default())
            .unwrap();

        let (code, _, err) = home.run(Command::WorkspaceRemove, target(&child));
        assert_eq!(code, 1);
        assert!(
            err.starts_with("heddle: workspace 'child' still holds 1 session(s)"),
            "{err}"
        );

        home.run(Command::WorkspaceAdd, target(&parent));
        let (code, text, _) = home.run(Command::WorkspaceRemove, target(&child));
        assert_eq!(code, 0);
        assert_eq!(
            text,
            format!("heddle: removed child  {child}\n  1 session(s) adopted by parent\n")
        );

        let (code, _, err) = home.run(Command::WorkspaceRemove, Args::default());
        assert_eq!(
            (code, err.as_str()),
            (1, "heddle: workspace remove needs a workspace id or path\n")
        );
        let (code, _, err) = home.run(Command::WorkspaceRemove, target("not-a-root"));
        assert_eq!(code, 1);
        assert!(err.starts_with("heddle: no workspace '"), "{err}");
    }

    #[test]
    fn workspace_rename_keeps_the_typescript_sentences() {
        let home = Home::new();
        let work = home.folder("work");
        home.run(Command::WorkspaceAdd, target(&work));
        let (code, text, _) = home.run(
            Command::WorkspaceRename,
            Args {
                name: Some("  Renamed  ".to_string()),
                ..target(&work)
            },
        );
        assert_eq!(
            (code, text),
            (0, format!("heddle: renamed to Renamed  {work}\n"))
        );

        // A rename without a positional is refused with the add sentence, as the TypeScript build does.
        let (code, _, err) = home.run(Command::WorkspaceRename, Args::default());
        assert_eq!(
            (code, err.as_str()),
            (1, "heddle: workspace add needs a path\n")
        );
        let (code, _, err) = home.run(Command::WorkspaceRename, target(&work));
        assert_eq!(
            (code, err.as_str()),
            (1, "heddle: a workspace needs a name\n")
        );
        let (code, _, err) = home.run(
            Command::WorkspaceRename,
            Args {
                name: Some("x".to_string()),
                ..target("session-not-a-workspace")
            },
        );
        assert_eq!(
            (code, err.as_str()),
            (1, "heddle: no workspace 'session-not-a-workspace'\n")
        );
    }

    #[test]
    fn tree_refuses_a_path_outside_every_root_and_walks_one_inside() {
        let home = Home::new();
        let work = home.folder("work");
        home.folder("work/_tools_/some-tool");
        std::fs::write(Path::new(&work).join("AGENTS.md"), "# entry\n").unwrap();
        let outside = home.folder("outside");
        home.run(Command::WorkspaceAdd, target(&work));

        let (code, out, err) = home.run(Command::Tree, target(&outside));
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(
            err,
            format!(
                "heddle: {outside} is not under any workspace root; register it with 'heddle workspace add {outside}'\n"
            )
        );

        let (code, out, _) = home.run(
            Command::Tree,
            Args {
                json: true,
                ..target(&work)
            },
        );
        assert_eq!(code, 0);
        let node: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(node["kind"], "workspace");
        assert_eq!(node["children"][0]["label"], "_tools_");
        assert_eq!(node["children"][0]["badge"], "TLS");

        let (_, text, _) = home.run(Command::Tree, target(&work));
        assert_eq!(
            text,
            format!(
                "heddle: 2 node(s) under {work}\n  workspace work\n    type      _tools_ [TLS]\n    file      AGENTS.md\n"
            )
        );
    }

    #[test]
    fn the_virtual_root_is_described_as_the_workspace_level() {
        let home = Home::new();
        let work = home.folder("work");
        home.run(Command::WorkspaceAdd, target(&work));
        let (code, text, _) = home.run(Command::Tree, Args::default());
        assert_eq!(code, 0);
        let mut lines = text.lines();
        assert_eq!(
            lines.next(),
            Some("heddle: 1 node(s) under the workspace level")
        );
        assert_eq!(lines.next(), Some("  roots     workspaces"));
        assert_eq!(lines.next(), Some("    workspace work"));
    }

    #[test]
    fn a_generated_flag_adds_to_the_profiles_names() {
        let home = Home::new();
        let work = home.folder("work");
        home.folder("work/dist");
        home.folder("work/build");
        home.run(Command::WorkspaceAdd, target(&work));
        let (_, out, _) = home.run(
            Command::Tree,
            Args {
                json: true,
                generated: vec!["build".to_string()],
                ..target(&work)
            },
        );
        let node: Value = serde_json::from_str(&out).unwrap();
        let kinds: Vec<(&str, &str)> = node["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|child| {
                (
                    child["label"].as_str().unwrap(),
                    child["kind"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(kinds, [("build", "generated"), ("dist", "generated")]);
    }

    #[test]
    fn file_reads_inside_a_root_and_refuses_outside_one() {
        let home = Home::new();
        let work = home.folder("work");
        let outside = home.folder("outside");
        std::fs::write(Path::new(&work).join("no-newline.txt"), "one\ntwo").unwrap();
        std::fs::write(Path::new(&outside).join("secret.md"), "# private\n").unwrap();
        home.run(Command::WorkspaceAdd, target(&work));

        let (code, text, _) = home.run(Command::File, target(&format!("{work}/no-newline.txt")));
        assert_eq!(
            (code, text.as_str()),
            (0, "one\ntwo\n"),
            "a missing newline is added"
        );

        let (_, out, _) = home.run(
            Command::File,
            Args {
                json: true,
                ..target(&format!("{work}/no-newline.txt"))
            },
        );
        let reading: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            reading.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["path", "name", "bytes", "lines", "text", "truncated"]
        );
        assert_eq!(reading["lines"], 2);

        let secret = format!("{outside}/secret.md");
        let (code, out, err) = home.run(Command::File, target(&secret));
        assert_eq!((code, out.as_str()), (1, ""));
        assert_eq!(
            err,
            format!(
                "heddle: {secret} is not under any workspace root; register its folder with 'heddle workspace add <path>'\n"
            )
        );
        let (code, _, err) = home.run(Command::File, Args::default());
        assert_eq!((code, err.as_str()), (1, "heddle: file needs a path\n"));
        let (code, _, err) = home.run(Command::File, target(&work));
        assert_eq!(code, 1);
        assert!(err.ends_with("is not a file\n"), "{err}");
    }

    #[test]
    fn session_new_writes_its_definition_and_registers_the_branch() {
        let home = Home::new();
        let branch = home.folder("branch");
        let (code, out, err) = home.run(
            Command::SessionNew,
            Args {
                json: true,
                name: Some("A named session".to_string()),
                ..target(&branch)
            },
        );
        assert_eq!((code, err.as_str()), (0, ""));
        let created: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            created.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["session", "name", "definition", "log"]
        );
        let definition = created["definition"].as_str().unwrap();
        assert!(Path::new(definition).exists());
        assert!(definition.starts_with(&format!("{branch}/_sessions_/")));
        // The branch had no root, so it was adopted: a session always has a workspace.
        assert!(home.workspaces.owner(&branch).is_some());
        assert_eq!(home.sessions.list()[0].title(), Some("A named session"));

        let (code, text, _) = home.run(Command::SessionNew, target(&branch));
        assert_eq!(code, 0);
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].starts_with("heddle: session session-"), "{text}");
        assert!(
            lines[0].contains(&format!(" at {branch}/_sessions_/")),
            "{text}"
        );
        assert!(lines[1].starts_with("heddle: its log is "), "{text}");
    }

    #[test]
    fn session_new_without_a_branch_uses_the_runs_directory() {
        let home = Home::new();
        let branch = home.folder("here");
        let (code, out, _) = home.run_with(
            Command::SessionNew,
            json(),
            Some(&home.workspaces),
            Path::new(&branch),
        );
        assert_eq!(code, 0);
        let created: Value = serde_json::from_str(&out).unwrap();
        assert!(
            created["definition"]
                .as_str()
                .unwrap()
                .starts_with(&format!("{branch}/_sessions_/"))
        );
    }

    #[test]
    fn a_profile_without_the_workspace_row_is_refused_after_the_argument_check() {
        let home = Home::new();
        let work = home.folder("work");
        let refusal = format!("heddle: {NO_WORKSPACE}\n");
        for (command, args) in [
            (Command::Workspaces, Args::default()),
            (Command::WorkspaceAdd, target(&work)),
            (Command::WorkspaceRemove, target(&work)),
            (Command::WorkspaceRename, target(&work)),
            (Command::Tree, target(&work)),
            (Command::File, target(&work)),
            (Command::SessionNew, target(&work)),
        ] {
            let (code, out, err) = home.run_with(command, args, None, home.dir.path());
            assert_eq!(
                (code, out.as_str(), err.as_str()),
                (1, "", refusal.as_str()),
                "{command:?}"
            );
        }
        // The positional is checked first, as the TypeScript build does.
        let (_, _, err) = home.run_with(
            Command::WorkspaceAdd,
            Args::default(),
            None,
            home.dir.path(),
        );
        assert_eq!(err, "heddle: workspace add needs a path\n");
    }
}
