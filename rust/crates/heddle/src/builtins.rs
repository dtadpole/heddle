//! What a row's `name` starts: a built-in from one of the crates, or an outside process.
//!
//! The TypeScript build imports a row's `name` as a module. The Rust binary cannot, so it keeps the same
//! rows and **recognises** them: a name whose path ends in `src/<module>.ts` (or `dist/<module>.js`) for
//! one of the modules in [`BUILTINS`] starts that built-in, wherever the checkout is — the repository's
//! `heddle.patch.yml` names `./src/plugins/session.ts`, a verifier's fixture names
//! `<repo>/src/plugins/session.ts`, and both mean the session built-in. A **bare** name (`session`,
//! `model`, the row ids of the default profile) names a built-in directly, which is the Rust-native
//! spelling `heddle-config` anticipates (`ComponentName::Bare`). Any other path names an
//! **outside component**: a process declared in configuration and spoken to as line-delimited JSON on
//! stdio (part 4 of `rust/ULTIMATE_GOAL.md`), hosted by `heddle-tools`. A bare package specifier that
//! is neither is unresolved, and its row fails to load, naming the row.
//!
//! Each built-in is started by an adapter that reads its row's `config` into the owning crate's typed
//! config, takes the services it injects from [`Services`], constructs the crate's service, and
//! registers the concrete handle and the [`ports`](crate::ports) view under the name it provides.

use std::path::{Component as PathComponent, Path, PathBuf};

use heddle_config::{ComponentCatalog, ComponentName, EntryRow, Schema, SchemaLookup};
use serde_json::Value;

use crate::services::Services;

/// The components built into the binary, one per module the TypeScript rows name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Builtin {
    /// `src/plugins/console-exporter.ts`: plugin log lines to the terminal.
    Console,
    /// `src/plugins/greeting.ts`: the first service, `greet(who)`.
    Greeting,
    /// `src/plugins/announce.ts`: greets the target on `heddle/ready`.
    Announce,
    /// `src/plugins/session.ts`.
    Session,
    /// `src/plugins/model.ts`.
    Model,
    /// `src/context/service.ts`.
    Context,
    /// `src/workspace/service.ts`.
    Workspace,
    /// `src/sandbox/service.ts`.
    Sandbox,
    /// `src/approvals/service.ts`.
    Approvals,
    /// `src/goal/service.ts`.
    Goal,
    /// `src/plugins/goal-driver.ts`.
    GoalDriver,
    /// `src/plugins/goal-tool.ts`.
    GoalTool,
    /// `src/plugins/subagent-tool.ts`.
    SubagentTool,
    /// `src/todo/service.ts`.
    Todo,
    /// `src/plugins/todo-tool.ts`.
    TodoTool,
    /// `src/plugins/turns.ts`.
    Turns,
    /// `src/plugins/team.ts`.
    Team,
    /// `src/plugins/tools.ts`.
    Tools,
}

/// One built-in: the module it stands for, the crate that implements it, and its service wiring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinSpec {
    /// Which built-in.
    pub builtin: Builtin,
    /// The TypeScript module under `src/`, without its extension.
    pub module: &'static str,
    /// The bare name that names it directly: its row id in the default profile.
    pub bare: &'static str,
    /// The name the plugin is registered under when no row id labels it (`createApp`'s tree).
    pub runtime_name: &'static str,
    /// The service name it provides, if any.
    pub provides: Option<&'static str>,
    /// The services the module itself injects; a row's `inject` adds to these.
    pub requires: &'static [&'static str],
    /// The crate that implements it.
    pub crate_name: &'static str,
}

/// Every built-in, read off the TypeScript modules' `name`, `provide` and `inject` declarations.
pub const BUILTINS: &[BuiltinSpec] = &[
    spec(
        Builtin::Console,
        "plugins/console-exporter",
        "console",
        "console-exporter",
        None,
        &[],
        "heddle",
    ),
    spec(
        Builtin::Greeting,
        "plugins/greeting",
        "greeting",
        "Greeting",
        Some("greeting"),
        &[],
        "heddle",
    ),
    spec(
        Builtin::Announce,
        "plugins/announce",
        "announce",
        "announce",
        None,
        &["greeting"],
        "heddle",
    ),
    spec(
        Builtin::Session,
        "plugins/session",
        "session",
        "session",
        Some("session"),
        &[],
        "heddle-session",
    ),
    spec(
        Builtin::Model,
        "plugins/model",
        "model",
        "model",
        Some("model"),
        &[],
        "heddle-llm",
    ),
    spec(
        Builtin::Context,
        "context/service",
        "context",
        "context",
        Some("context"),
        &["model", "session"],
        "heddle-context",
    ),
    spec(
        Builtin::Workspace,
        "workspace/service",
        "workspace",
        "workspace",
        Some("workspace"),
        &["session"],
        "heddle-workspace",
    ),
    spec(
        Builtin::Sandbox,
        "sandbox/service",
        "sandbox",
        "sandbox",
        Some("sandbox"),
        &[],
        "heddle-sandbox",
    ),
    spec(
        Builtin::Approvals,
        "approvals/service",
        "approvals",
        "approvals",
        Some("approvals"),
        &[],
        "heddle-sandbox",
    ),
    spec(
        Builtin::Goal,
        "goal/service",
        "goal",
        "goal",
        Some("goal"),
        &["session"],
        "heddle-goal",
    ),
    spec(
        Builtin::GoalDriver,
        "plugins/goal-driver",
        "goal-driver",
        "goal-driver",
        Some("goalDriver"),
        &["goal", "session", "model", "tools", "sandbox", "context"],
        "heddle-goal",
    ),
    spec(
        Builtin::GoalTool,
        "plugins/goal-tool",
        "goal-tool",
        "goal-tool",
        None,
        &["goal", "tools"],
        "heddle-goal",
    ),
    spec(
        Builtin::SubagentTool,
        "plugins/subagent-tool",
        "subagent-tool",
        "subagent-tool",
        None,
        &["tools", "session", "model", "sandbox", "context"],
        "heddle-agent",
    ),
    spec(
        Builtin::Todo,
        "todo/service",
        "todo",
        "todo",
        Some("todo"),
        &["session"],
        "heddle-todo",
    ),
    spec(
        Builtin::TodoTool,
        "plugins/todo-tool",
        "todo-tool",
        "todo-tool",
        None,
        &["todo", "tools"],
        "heddle-todo",
    ),
    spec(
        Builtin::Turns,
        "plugins/turns",
        "turns",
        "turns",
        Some("turns"),
        &[],
        "heddle-agent",
    ),
    spec(
        Builtin::Team,
        "plugins/team",
        "team",
        "team",
        Some("team"),
        &["session", "model", "tools", "context", "sandbox"],
        "heddle-team",
    ),
    spec(
        Builtin::Tools,
        "plugins/tools",
        "tools",
        "tools",
        Some("tools"),
        &["approvals", "sandbox", "session"],
        "heddle-tools",
    ),
];

const fn spec(
    builtin: Builtin,
    module: &'static str,
    bare: &'static str,
    runtime_name: &'static str,
    provides: Option<&'static str>,
    requires: &'static [&'static str],
    crate_name: &'static str,
) -> BuiltinSpec {
    BuiltinSpec {
        builtin,
        module,
        bare,
        runtime_name,
        provides,
        requires,
        crate_name,
    }
}

impl Builtin {
    /// This built-in's entry in [`BUILTINS`].
    pub fn spec(self) -> &'static BuiltinSpec {
        BUILTINS
            .iter()
            .find(|entry| entry.builtin == self)
            .expect("every built-in has exactly one entry in BUILTINS")
    }
}

/// What a row's `name` resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentRef {
    /// One of the built-ins.
    Builtin(Builtin),
    /// An outside component: a process at this path.
    Outside(PathBuf),
    /// A bare specifier that is neither; its row fails to load.
    Unresolved(String),
}

/// What a row's name, as `heddle-config` resolved it (`EntryRow::component`), starts.
///
/// Lexical only — nothing is read from disk, so `config --validate` can resolve a tree without starting
/// it. A path is a built-in when it ends in `src/<module>.ts` or `dist/<module>.js` for a module in
/// [`BUILTINS`]; any other path is an outside component. A bare name is a built-in when it is one's
/// [`BuiltinSpec::bare`] name, and unresolved otherwise.
pub fn resolve_component(name: &ComponentName) -> ComponentRef {
    match name {
        ComponentName::Bare(bare) => BUILTINS
            .iter()
            .find(|entry| entry.bare == bare)
            .map_or_else(
                || ComponentRef::Unresolved(bare.clone()),
                |entry| ComponentRef::Builtin(entry.builtin),
            ),
        ComponentName::Path(path) => {
            let path = normalize(path);
            BUILTINS
                .iter()
                .find(|entry| names_module(&path, entry.module))
                .map_or_else(
                    || ComponentRef::Outside(path.clone()),
                    |entry| ComponentRef::Builtin(entry.builtin),
                )
        }
    }
}

/// Whether `path` is `…/src/<module>.ts` or `…/dist/<module>.js`.
fn names_module(path: &Path, module: &str) -> bool {
    let (root, extension) = match path.extension().and_then(|extension| extension.to_str()) {
        Some("ts") => ("src", "ts"),
        Some("js") => ("dist", "js"),
        _ => return false,
    };
    let wanted: Vec<String> = std::iter::once(root.to_owned())
        .chain(module.split('/').map(str::to_owned))
        .collect();
    let mut parts: Vec<String> = path
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let Some(last) = parts.last_mut() else {
        return false;
    };
    let Some(stem) = last
        .strip_suffix(&format!(".{extension}"))
        .map(str::to_owned)
    else {
        return false;
    };
    *last = stem;
    parts.ends_with(&wanted)
}

/// One startable component: what it needs, what its config looks like, and how to start it.
pub trait Component: Send + Sync {
    /// The service names it needs before it can start, beyond those its row's `inject` adds.
    fn requires(&self) -> Vec<String>;
    /// Its config's schema, which `config --validate` checks a row against without starting anything;
    /// `None` when it takes no config. The owning crate publishes it beside its typed config.
    fn schema(&self) -> Option<Schema>;
    /// Start it: read `config`, take what it injects from `services`, and register what it provides.
    /// An `Err` leaves its row failed, with the sentence in the boot's report.
    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String>;
}

/// Where the boot finds the [`Component`] a row names.
pub trait Catalog {
    /// The component for `reference`, or `None` when it cannot be started (its row fails).
    fn component(&self, reference: &ComponentRef) -> Option<Box<dyn Component>>;
}

/// The binary's own catalog: an adapter per built-in, and the outside-process host for other paths.
#[derive(Debug, Default, Clone, Copy)]
pub struct BuiltinCatalog;

impl Catalog for BuiltinCatalog {
    fn component(&self, reference: &ComponentRef) -> Option<Box<dyn Component>> {
        let _ = reference;
        todo!(
            "one adapter per built-in, added as each crate's API lands; outside paths go to heddle-tools"
        )
    }
}

/// `config --validate` asks the same catalog for schemas: a built-in's from its adapter, an outside
/// component's from its declaration, and an unresolved name as `SchemaLookup::Unresolvable`.
impl ComponentCatalog for BuiltinCatalog {
    fn lookup(&self, row: &EntryRow, anchor: Option<&Path>) -> SchemaLookup {
        // A bare row name needs no directory; a relative path is resolved against the layer that wrote
        // it, and only an all-in-memory tree has none, where `.` is the same relative name.
        let anchor = anchor.unwrap_or(Path::new("."));
        match resolve_component(&row.component(anchor)) {
            // One adapter per built-in lands with its crate (port plan step 5); until then a built-in
            // takes no declared schema, which validation skips rather than calling it a problem.
            ComponentRef::Builtin(_) => SchemaLookup::NoSchema,
            ComponentRef::Outside(path) => SchemaLookup::Unresolvable(format!(
                "the outside component '{}' declares no schema to this binary yet",
                path.display()
            )),
            ComponentRef::Unresolved(name) => {
                SchemaLookup::Unresolvable(format!("no built-in or outside path is named '{name}'"))
            }
        }
    }
}

/// Lexically normalise a path: drop `.` and fold `..` into its parent, without touching the disk.
pub fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for part in path.components() {
        match part {
            PathComponent::CurDir => {}
            PathComponent::ParentDir => {
                if !normal.pop() {
                    normal.push("..");
                }
            }
            other => normal.push(other.as_os_str()),
        }
    }
    normal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_has_exactly_one_entry() {
        for entry in BUILTINS {
            let count = BUILTINS
                .iter()
                .filter(|other| other.builtin == entry.builtin)
                .count();
            assert_eq!(count, 1, "{:?}", entry.builtin);
            assert_eq!(entry.builtin.spec().module, entry.module);
        }
    }

    #[test]
    fn module_paths_are_unique_and_name_real_typescript_modules() {
        for entry in BUILTINS {
            assert_eq!(
                BUILTINS
                    .iter()
                    .filter(|other| other.module == entry.module)
                    .count(),
                1
            );
            assert!(
                !entry.module.ends_with(".ts") && !entry.module.starts_with('/'),
                "{}",
                entry.module
            );
        }
    }

    #[test]
    fn every_row_of_the_default_profile_is_a_builtin() {
        let profile = include_str!("../../../../heddle.patch.yml");
        let named: Vec<&str> = profile
            .lines()
            .filter_map(|line| line.trim().strip_prefix("name: ./src/"))
            .map(|module| module.trim_end_matches(".ts"))
            .collect();
        assert!(
            named.len() >= 16,
            "the default profile names its rows: {named:?}"
        );
        for module in named {
            assert!(
                BUILTINS.iter().any(|entry| entry.module == module),
                "no built-in for src/{module}.ts"
            );
        }
    }

    fn path(text: &str) -> ComponentRef {
        resolve_component(&ComponentName::Path(PathBuf::from(text)))
    }

    fn bare(text: &str) -> ComponentRef {
        resolve_component(&ComponentName::Bare(text.to_owned()))
    }

    #[test]
    fn a_typescript_module_path_is_its_builtin_wherever_the_checkout_is() {
        // The repository's own profile, resolved against its base layer's directory.
        assert_eq!(
            path("/home/someone/heddle/src/plugins/session.ts"),
            ComponentRef::Builtin(Builtin::Session)
        );
        // A verifier's fixture names the module under the repository root, from another directory.
        assert_eq!(
            path("/tmp/checkout/./src/context/../context/service.ts"),
            ComponentRef::Builtin(Builtin::Context)
        );
        // The built output names the same modules.
        assert_eq!(
            path("/opt/heddle/dist/plugins/tools.js"),
            ComponentRef::Builtin(Builtin::Tools)
        );
    }

    #[test]
    fn every_builtin_round_trips_through_its_module_path_and_its_bare_name() {
        for entry in BUILTINS {
            let typescript = format!("/repo/src/{}.ts", entry.module);
            assert_eq!(
                path(&typescript),
                ComponentRef::Builtin(entry.builtin),
                "{typescript}"
            );
            assert_eq!(
                bare(entry.bare),
                ComponentRef::Builtin(entry.builtin),
                "{}",
                entry.bare
            );
        }
    }

    #[test]
    fn any_other_path_is_an_outside_component() {
        let outside = |text: &str| ComponentRef::Outside(PathBuf::from(text));
        assert_eq!(
            path("/fixture/profiles/dev/alpha.ts"),
            outside("/fixture/profiles/dev/alpha.ts")
        );
        assert_eq!(
            path("/x/src/plugins/unknown.ts"),
            outside("/x/src/plugins/unknown.ts")
        );
        assert_eq!(
            path("/x/lib/plugins/session.ts"),
            outside("/x/lib/plugins/session.ts"),
            "not under src/"
        );
        assert_eq!(
            path("/x/src/plugins/session.js"),
            outside("/x/src/plugins/session.js"),
            "js is dist's"
        );
        assert_eq!(
            path("/x/src/plugins/session"),
            outside("/x/src/plugins/session"),
            "no extension"
        );
        assert_eq!(path("/x/tools/echo-tool"), outside("/x/tools/echo-tool"));
    }

    #[test]
    fn a_bare_name_that_is_no_builtin_is_unresolved() {
        assert_eq!(
            bare("@deepseek-ai/cordis"),
            ComponentRef::Unresolved("@deepseek-ai/cordis".to_owned())
        );
        assert_eq!(
            bare("Session"),
            ComponentRef::Unresolved("Session".to_owned()),
            "names are exact"
        );
    }

    #[test]
    fn bare_names_are_the_default_profiles_row_ids() {
        let profile = include_str!("../../../../heddle.patch.yml");
        let ids: Vec<&str> = profile
            .lines()
            .filter_map(|line| line.trim().strip_prefix("- id: "))
            .collect();
        assert!(ids.len() >= 16, "{ids:?}");
        for id in ids {
            assert!(
                matches!(bare(id), ComponentRef::Builtin(_)),
                "row id '{id}' is no bare built-in"
            );
        }
    }

    #[test]
    fn normalize_folds_dot_segments_without_the_disk() {
        assert_eq!(
            normalize(Path::new("/a/b/./../c/d.ts")),
            PathBuf::from("/a/c/d.ts")
        );
        assert_eq!(normalize(Path::new("a/../../b")), PathBuf::from("../b"));
    }
}
