//! Booting a tree from configuration: port of `src/boot.ts` and of the parts of Cordis's loader it uses.
//!
//! `heddle-config` composes the layers into rows; the boot only starts what that produced, so every rule
//! about layers can be checked without starting anything. Starting is the loader's job, kept here:
//! each enabled row becomes an [`Entry`] whose component comes from the [`Catalog`]; an entry starts once
//! every service it requires (its component's own plus its row's `inject`) is provided, and stays
//! [`FiberState::Pending`] otherwise — the honest signal of a missing service, which [`settle`] reports.
//! A component that refuses to start leaves its entry [`FiberState::Failed`], which [`failed_entries`]
//! reports, because a failed row measured as the worst silence in the TypeScript build (a run that
//! printed four healthy tools and exited 0).
//!
//! Row order carries no load semantics: the loader starts whatever is ready, repeatedly, until nothing
//! more can start.

use std::path::{Path, PathBuf};

use heddle_config::{ComposedRow, Env, LayerOptions, NamedLayer};

use crate::builtins::{Catalog, Component, ComponentRef, resolve_component};
use crate::services::Services;

/// An entry's lifecycle, numbered as Cordis's `FiberState` in `src/fiber.ts`, whose names the tree prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum FiberState {
    /// Waiting for a service it injects.
    Pending = 0,
    /// Starting.
    Loading = 1,
    /// Started.
    Active = 2,
    /// Its start refused.
    Failed = 3,
    /// Stopped.
    Disposed = 4,
    /// Stopping.
    Unloading = 5,
}

impl FiberState {
    /// The state's name as the tree prints it (`STATES` in `src/cli.ts`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Loading => "loading",
            Self::Active => "active",
            Self::Failed => "failed",
            Self::Disposed => "disposed",
            Self::Unloading => "unloading",
        }
    }

    /// Whether the entry has not finished loading: pending **and** loading, as `settle` counts them.
    pub fn is_unsettled(self) -> bool {
        matches!(self, Self::Pending | Self::Loading)
    }
}

/// One row in the loader's tree.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// The configured id, or the one the loader assigned: the label the tree prints.
    pub id: String,
    /// The row's `name`, as written.
    pub name: String,
    /// What the name resolved to.
    pub component: ComponentRef,
    /// Every service it waits for.
    pub requires: Vec<String>,
    /// Where it is in its lifecycle.
    pub state: FiberState,
    /// Why it failed, when it did.
    pub error: Option<String>,
}

/// Options for [`boot`]: port of `BootOptions`.
#[derive(Debug, Clone, PartialEq)]
pub struct BootOptions {
    /// The layer files, from [`crate::cli::layer_options`].
    pub layers: LayerOptions,
    /// In-memory layers applied after the files (`--session-root`, `--sandbox-root`), from
    /// [`crate::cli::root_overrides`].
    pub overrides: Vec<NamedLayer>,
    /// Who the run is for, announced on `heddle/ready`.
    pub target: String,
    /// The environment for `${NAME}`, `!env NAME`, `HEDDLE_HOME` and `HOME`.
    pub env: Env,
}

/// A boot that could not compose its tree: the composition's own sentence (a cycle, a missing
/// variable, a patch against an unknown row, an unknown profile).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct BootError(pub String);

/// A booted tree: port of `Boot`.
#[derive(Debug)]
pub struct Boot {
    /// The rows the layers composed, in order, with where each field came from.
    pub rows: Vec<ComposedRow>,
    /// The loader's entries, in creation order.
    pub entries: Vec<Entry>,
    /// Every service the started entries provide.
    pub services: Services,
    /// The base layer's directory, which relative row names resolved against.
    pub anchor: PathBuf,
}

/// Compose the layers through `heddle-config` (`default_layers`, the overrides, `compose`), then
/// [`load`] the rows against `anchor_dir` of those layers and announce `heddle/ready`.
pub fn boot(options: &BootOptions, catalog: &dyn Catalog) -> Result<Boot, BootError> {
    let mut layers = heddle_config::default_layers(&options.layers, &options.env)
        .map_err(|error| BootError(error.to_string()))?;
    // The flags' in-memory layers come after every file layer, as `src/boot.ts` appends them.
    layers.extend(options.overrides.iter().cloned());
    let rows = heddle_config::compose(&layers, &options.env)
        .map_err(|error| BootError(error.to_string()))?;
    // Relative row names resolve against the base layer's own directory, never the working
    // directory: measured in the TypeScript build, and the reason a fixture's `./alpha.ts` means the
    // file beside the layer that wrote it. A tree with no file layer at all has only the working
    // directory to fall back on, which is what `.` is.
    let anchor = heddle_config::anchor_dir(&layers).unwrap_or_else(|| PathBuf::from("."));
    Ok(load(rows, &anchor, catalog))
}

/// Start the rows: the loader. Disabled rows get no entry; every other row gets one, started as soon as
/// what it requires is provided, repeatedly, until nothing more can start.
pub fn load(rows: Vec<ComposedRow>, anchor: &Path, catalog: &dyn Catalog) -> Boot {
    let mut services = Services::new();
    // One bus per process, its catalog exposed before any row can attach a listener: the model, the
    // tools, the turn and every outside component reach the hook points through it.
    let bus = heddle_events::EventBus::new();
    heddle_events::bridge::expose_catalog(&bus);
    services.provide("events", bus);
    // The server's hub exists before the session store, which needs its listener when it is built:
    // `heddle web` hands the same hub to the server, so the page sees every event the store appends.
    services.provide("event-hub", heddle_server::EventHub::new());
    // `--stream`'s live view is fed from the same listener, synchronously, so a delta reaches the terminal
    // while the turn runs.
    services.provide(
        "stream-hub",
        std::sync::Arc::new(heddle_llm::command::StreamHub::new()),
    );
    let mut entries = Vec::new();
    // The component each entry starts, in the entries' own order; `None` when the row names nothing
    // the catalog knows, which leaves that entry failed rather than pending forever.
    let mut starters: Vec<Option<(Box<dyn Component>, serde_json::Value)>> = Vec::new();
    for composed in &rows {
        let row = &composed.row;
        if row.disabled == Some(true) {
            continue;
        }
        let reference = resolve_component(&row.component(anchor));
        let component = catalog.component(&reference);
        let mut requires = component
            .as_ref()
            .map(|component| component.requires())
            .unwrap_or_default();
        // A row's own `inject` adds to the module's, in the order the row wrote it, without repeats:
        // the gate is a set of service names, not a sequence.
        for name in row.inject.iter().flatten() {
            if !requires.contains(name) {
                requires.push(name.clone());
            }
        }
        let (state, error) = match &component {
            Some(_) => (FiberState::Pending, None),
            None => (
                FiberState::Failed,
                Some(format!(
                    "nothing answers for '{}'; it is neither a built-in nor a component this binary knows",
                    row.name
                )),
            ),
        };
        // A row that writes no `config` (or `config: null`) hands its component `{}`, as a Cordis plugin
        // receives `{}` and fills its schema's defaults; `null` would refuse every typed config.
        let config = match &row.config {
            None | Some(serde_json::Value::Null) => {
                serde_json::Value::Object(serde_json::Map::new())
            }
            Some(config) => config.clone(),
        };
        entries.push(Entry {
            id: row.id.clone().unwrap_or_else(|| row.name.clone()),
            name: row.name.clone(),
            component: reference,
            requires,
            state,
            error,
        });
        starters.push(component.map(|component| (component, config)));
    }

    // Start whatever is ready, repeatedly, until nothing more can start. Row order carries no load
    // semantics, so an entry later in the tree starts in the same sweep once its service exists.
    loop {
        let mut started_any = false;
        for (index, entry) in entries.iter_mut().enumerate() {
            if entry.state != FiberState::Pending
                || !entry.requires.iter().all(|name| services.provides(name))
            {
                continue;
            }
            entry.state = FiberState::Loading;
            match starters[index].as_ref() {
                Some((component, config)) => match component.start(config, &mut services) {
                    Ok(()) => entry.state = FiberState::Active,
                    Err(message) => {
                        entry.state = FiberState::Failed;
                        entry.error = Some(message);
                    }
                },
                None => {
                    entry.state = FiberState::Failed;
                    entry.error = Some(format!("nothing answers for '{}'", entry.name));
                }
            }
            started_any = true;
        }
        if !started_any {
            break;
        }
    }

    Boot {
        rows,
        entries,
        services,
        anchor: anchor.to_path_buf(),
    }
}

/// The ids of entries that have not finished loading: port of `settle`.
///
/// The Rust loader starts components synchronously, so nothing is left loading when [`load`] returns
/// and there is nothing to wait for: what is unsettled now stays unsettled.
pub fn settle(boot: &Boot) -> Vec<String> {
    boot.entries
        .iter()
        .filter(|entry| entry.state.is_unsettled())
        .map(|entry| entry.id.clone())
        .collect()
}

/// The `(id, name)` of every entry whose start refused: port of `failedEntries`.
pub fn failed_entries(boot: &Boot) -> Vec<(String, String)> {
    boot.entries
        .iter()
        .filter(|entry| entry.state == FiberState::Failed)
        .map(|entry| (entry.id.clone(), entry.name.clone()))
        .collect()
}

/// What each failed row said when it failed, as the loader's log line: `<id>: <error>`. The TypeScript
/// loader logs a plugin's thrown error through the console exporter, which is where a person (and a
/// check) reads why a row did not start.
pub fn failure_lines(boot: &Boot) -> Vec<String> {
    boot.entries
        .iter()
        .filter(|entry| entry.state == FiberState::Failed)
        .filter_map(|entry| {
            entry
                .error
                .as_ref()
                .map(|error| format!("{}: {error}", entry.id))
        })
        .collect()
}

impl Boot {
    /// Stop every started entry in reverse order and withdraw what it provided: `ctx.fiber.dispose()`.
    ///
    /// The registry is dropped as a whole after the entries are marked: a component's `start` owns
    /// whatever it provided, and with the tree gone nothing can read it any more.
    pub fn dispose(mut self) {
        for entry in self.entries.iter_mut().rev() {
            if entry.state == FiberState::Active {
                entry.state = FiberState::Disposed;
            }
        }
        self.services = Services::new();
    }
}

/// The loaded tree as `printTree` prints it: `heddle: N plugin(s) loaded`, then one line per entry,
/// its label padded to 16, `1 fiber(s)` and its state's name.
pub fn describe_entries(entries: &[(String, FiberState)]) -> String {
    let mut text = format!("heddle: {} plugin(s) loaded\n", entries.len());
    for (label, state) in entries {
        text.push_str(&format!("  {label:<16} 1 fiber(s)  {}\n", state.name()));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree_with(states: &[FiberState]) -> Boot {
        Boot {
            rows: Vec::new(),
            entries: states
                .iter()
                .enumerate()
                .map(|(index, state)| Entry {
                    id: format!("row-{index}"),
                    name: format!("./row-{index}.ts"),
                    component: ComponentRef::Unresolved(format!("row-{index}")),
                    requires: Vec::new(),
                    state: *state,
                    error: None,
                })
                .collect(),
            services: Services::new(),
            anchor: PathBuf::from("/"),
        }
    }

    // The three cases of test/boot.test.ts, which pinned the bug where a loading row did not count.
    use crate::builtins::Builtin;

    /// A component the loader tests can start, refuse, or leave waiting on a service.
    #[derive(Clone)]
    struct Stub {
        requires: Vec<String>,
        provides: Option<String>,
        refuses: bool,
    }

    impl Stub {
        fn new(requires: &[&str], provides: Option<&str>) -> Self {
            Self {
                requires: requires.iter().map(|name| (*name).to_owned()).collect(),
                provides: provides.map(str::to_owned),
                refuses: false,
            }
        }
    }

    impl Component for Stub {
        fn requires(&self) -> Vec<String> {
            self.requires.clone()
        }

        fn schema(&self) -> Option<heddle_config::Schema> {
            None
        }

        fn start(
            &self,
            _config: &serde_json::Value,
            services: &mut Services,
        ) -> Result<(), String> {
            if self.refuses {
                return Err("the stub refused to start".to_owned());
            }
            if let Some(name) = &self.provides {
                services.provide(name, ());
            }
            Ok(())
        }
    }

    /// A catalog with one stub per built-in, so the loader can be judged without a crate.
    struct Stubs {
        entries: Vec<(Builtin, Stub)>,
    }

    impl Stubs {
        fn new(entries: &[(Builtin, Stub)]) -> Self {
            Self {
                entries: entries.to_vec(),
            }
        }
    }

    impl Catalog for Stubs {
        fn component(&self, reference: &ComponentRef) -> Option<Box<dyn Component>> {
            match reference {
                ComponentRef::Builtin(builtin) => self
                    .entries
                    .iter()
                    .find(|(candidate, _)| candidate == builtin)
                    .map(|(_, stub)| Box::new(stub.clone()) as Box<dyn Component>),
                _ => None,
            }
        }
    }

    fn row(id: &str, name: &str) -> ComposedRow {
        ComposedRow {
            row: heddle_config::EntryRow {
                id: Some(id.to_owned()),
                name: name.to_owned(),
                ..heddle_config::EntryRow::default()
            },
            position: 0,
            fields: Vec::new(),
        }
    }

    #[test]
    fn an_entry_starts_only_once_the_services_it_requires_are_provided() {
        // The requiring row comes first on purpose: row order carries no load semantics.
        let rows = vec![
            row("session", "./src/plugins/session.ts"),
            row("greeting", "./src/plugins/greeting.ts"),
        ];
        let catalog = Stubs::new(&[
            (Builtin::Session, Stub::new(&["greeting"], None)),
            (Builtin::Greeting, Stub::new(&[], Some("greeting"))),
        ]);
        let boot = load(rows, Path::new("/repo"), &catalog);
        assert_eq!(
            boot.entries
                .iter()
                .map(|entry| entry.state)
                .collect::<Vec<_>>(),
            vec![FiberState::Active, FiberState::Active]
        );
        assert!(boot.services.provides("greeting"));
        assert!(settle(&boot).is_empty());
    }

    #[test]
    fn an_entry_that_never_gets_its_service_stays_pending_and_settle_names_it() {
        let catalog = Stubs::new(&[(Builtin::Announce, Stub::new(&["greeting"], None))]);
        let boot = load(
            vec![row("announce", "./src/plugins/announce.ts")],
            Path::new("/repo"),
            &catalog,
        );
        assert_eq!(boot.entries[0].state, FiberState::Pending);
        assert_eq!(settle(&boot), vec!["announce".to_owned()]);
    }

    #[test]
    fn a_row_inject_adds_to_the_modules_own_requires() {
        let catalog = Stubs::new(&[(Builtin::Greeting, Stub::new(&[], Some("greeting")))]);
        let mut composed = row("greeting", "./src/plugins/greeting.ts");
        composed.row.inject = Some(vec!["extra".to_owned(), "greeting".to_owned()]);
        let boot = load(vec![composed], Path::new("/repo"), &catalog);
        assert_eq!(
            boot.entries[0].requires,
            vec![
                "extra".to_owned(),
                "greeting".to_owned(),
                // The module's own requires come first, and the row's "greeting" is already there.
            ]
        );
        assert_eq!(boot.entries[0].state, FiberState::Pending);
    }

    #[test]
    fn a_refused_start_leaves_the_row_failed_with_its_sentence() {
        let catalog = Stubs::new(&[(
            Builtin::Session,
            Stub {
                refuses: true,
                ..Stub::new(&[], Some("session"))
            },
        )]);
        let boot = load(
            vec![row("session", "./src/plugins/session.ts")],
            Path::new("/repo"),
            &catalog,
        );
        assert_eq!(boot.entries[0].state, FiberState::Failed);
        assert_eq!(
            boot.entries[0].error.as_deref(),
            Some("the stub refused to start")
        );
        assert!(settle(&boot).is_empty(), "failed is settled");
        assert_eq!(
            failed_entries(&boot),
            vec![("session".to_owned(), "./src/plugins/session.ts".to_owned())]
        );
    }

    #[test]
    fn a_row_that_names_nothing_the_catalog_knows_fails_naming_it() {
        let catalog = Stubs::new(&[]);
        let boot = load(
            vec![row("alpha", "./alpha.ts")],
            Path::new("/repo"),
            &catalog,
        );
        assert_eq!(boot.entries[0].component, {
            ComponentRef::Outside(PathBuf::from("/repo/alpha.ts"))
        });
        assert_eq!(boot.entries[0].state, FiberState::Failed);
        assert!(
            boot.entries[0]
                .error
                .as_deref()
                .is_some_and(|error| error.contains("./alpha.ts")),
            "the failure names the row's own spelling"
        );
    }

    /// A component that records the config it was started with.
    struct Recorder {
        seen: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    }

    impl Component for Recorder {
        fn requires(&self) -> Vec<String> {
            Vec::new()
        }

        fn schema(&self) -> Option<heddle_config::Schema> {
            None
        }

        fn start(
            &self,
            config: &serde_json::Value,
            _services: &mut Services,
        ) -> Result<(), String> {
            self.seen
                .lock()
                .expect("the recorder's lock")
                .push(config.clone());
            Ok(())
        }
    }

    struct Recording {
        seen: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    }

    impl Catalog for Recording {
        fn component(&self, _reference: &ComponentRef) -> Option<Box<dyn Component>> {
            Some(Box::new(Recorder {
                seen: std::sync::Arc::clone(&self.seen),
            }))
        }
    }

    #[test]
    fn a_row_without_config_starts_its_component_with_an_empty_object() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let catalog = Recording {
            seen: std::sync::Arc::clone(&seen),
        };
        let mut explicit_null = row("sandbox", "./src/sandbox/service.ts");
        explicit_null.row.config = Some(serde_json::Value::Null);
        let mut configured = row("approvals", "./src/approvals/service.ts");
        configured.row.config = Some(serde_json::json!({ "mode": "deny" }));
        let boot = load(
            vec![
                row("model", "./src/plugins/model.ts"),
                explicit_null,
                configured,
            ],
            Path::new("/repo"),
            &catalog,
        );
        assert!(
            boot.entries
                .iter()
                .all(|entry| entry.state == FiberState::Active)
        );
        assert_eq!(
            *seen.lock().expect("the recorder's lock"),
            vec![
                serde_json::json!({}),
                serde_json::json!({}),
                serde_json::json!({ "mode": "deny" }),
            ]
        );
    }

    #[test]
    fn a_disabled_row_gets_no_entry_at_all() {
        let catalog = Stubs::new(&[(Builtin::Greeting, Stub::new(&[], Some("greeting")))]);
        let mut composed = row("greeting", "./src/plugins/greeting.ts");
        composed.row.disabled = Some(true);
        let boot = load(vec![composed], Path::new("/repo"), &catalog);
        assert!(boot.entries.is_empty());
        assert_eq!(
            boot.rows.len(),
            1,
            "the row is still visible in the composition"
        );
    }

    #[test]
    fn a_row_without_an_id_is_labelled_by_its_name() {
        let catalog = Stubs::new(&[(Builtin::Greeting, Stub::new(&[], Some("greeting")))]);
        let mut composed = row("greeting", "./src/plugins/greeting.ts");
        composed.row.id = None;
        let boot = load(vec![composed], Path::new("/repo"), &catalog);
        assert_eq!(boot.entries[0].id, "./src/plugins/greeting.ts");
    }

    /// A fresh directory under the system temporary directory, so a test writes nothing in the tree.
    fn scratch(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("heddle-{label}-{}-{unique}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    /// A profile named `dev` holding a base layer and a patch layer, and the environment that names it.
    fn profile_fixture(label: &str, patch: &str) -> (PathBuf, Env) {
        let home = scratch(label);
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

    fn options(env: Env) -> BootOptions {
        BootOptions {
            layers: LayerOptions {
                profile: Some("dev".to_owned()),
                ..LayerOptions::default()
            },
            overrides: Vec::new(),
            target: "heddle".to_owned(),
            env,
        }
    }

    #[test]
    fn boot_composes_a_profile_and_starts_the_rows_it_names() {
        let (home, env) = profile_fixture(
            "boot",
            "- insert:\n    - id: session\n      name: ./src/plugins/session.ts\n    - id: greeting\n      name: ./src/plugins/greeting.ts\n",
        );
        let catalog = Stubs::new(&[
            (Builtin::Session, Stub::new(&["greeting"], None)),
            (Builtin::Greeting, Stub::new(&[], Some("greeting"))),
        ]);
        let boot = boot(&options(env), &catalog).expect("the profile composes");
        assert_eq!(boot.rows.len(), 2);
        assert_eq!(
            boot.entries
                .iter()
                .map(|entry| entry.state)
                .collect::<Vec<_>>(),
            vec![FiberState::Active, FiberState::Active],
            "the row that waits for greeting starts once it exists"
        );
        assert!(boot.services.provides("greeting"));
        assert_eq!(
            boot.anchor,
            home.join("profiles").join("dev"),
            "relative names resolve against the base layer's own directory"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn boot_refuses_a_patch_against_a_row_no_layer_inserted() {
        let (home, env) = profile_fixture(
            "boot-broken",
            "- insert:\n    - id: greeting\n      name: ./src/plugins/greeting.ts\n- patch:\n    - id: nowhere\n      config: {}\n",
        );
        let catalog = Stubs::new(&[(Builtin::Greeting, Stub::new(&[], Some("greeting")))]);
        let error = boot(&options(env), &catalog).expect_err("the composition is refused");
        assert!(
            error.0.contains("nowhere"),
            "the failure names the row: {}",
            error.0
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_override_layer_applies_after_the_profile() {
        let (home, env) = profile_fixture(
            "boot-override",
            "- insert:\n    - id: greeting\n      name: ./src/plugins/greeting.ts\n      config:\n        punctuation: '?'\n",
        );
        let mut boot_options = options(env);
        boot_options.overrides = vec![heddle_config::NamedLayer::inline(
            1,
            heddle_config::Layer::patching([serde_json::json!({
                "id": "greeting",
                "config": { "punctuation": "." },
            })]),
        )];
        let catalog = Stubs::new(&[(Builtin::Greeting, Stub::new(&[], Some("greeting")))]);
        let boot = boot(&boot_options, &catalog).expect("the override composes");
        assert_eq!(
            boot.rows[0].row.config,
            Some(serde_json::json!({ "punctuation": "." })),
            "a patch replaces the whole config, and it came last"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_config_error_is_the_boots_own_sentence() {
        let (home, env) = profile_fixture(
            "boot-unknown-profile",
            "- insert:\n    - id: greeting\n      name: ./src/plugins/greeting.ts\n",
        );
        let mut boot_options = options(env);
        boot_options.layers.profile = Some("nowhere".to_owned());
        let error = boot(&boot_options, &Stubs::new(&[])).expect_err("an unknown profile fails");
        assert!(
            error.0.contains("nowhere"),
            "the config crate's sentence carries through: {}",
            error.0
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn settle_counts_a_loading_row_as_unsettled_not_only_a_pending_one() {
        let boot = tree_with(&[FiberState::Active, FiberState::Loading, FiberState::Pending]);
        assert_eq!(settle(&boot), vec!["row-1".to_owned(), "row-2".to_owned()]);
    }

    #[test]
    fn settle_is_empty_once_every_row_is_active_failed_disposed_or_unloading() {
        let boot = tree_with(&[
            FiberState::Active,
            FiberState::Failed,
            FiberState::Disposed,
            FiberState::Unloading,
        ]);
        assert!(settle(&boot).is_empty());
    }

    #[test]
    fn failed_entries_names_each_failed_row_by_id_and_name() {
        let boot = tree_with(&[FiberState::Active, FiberState::Failed]);
        assert_eq!(
            failed_entries(&boot),
            vec![("row-1".to_owned(), "./row-1.ts".to_owned())]
        );
    }

    #[test]
    fn the_tree_prints_as_the_typescript_build_prints_it() {
        // Measured against `node dist/cli.js -q` in an empty folder, 2026-10-22.
        let text = describe_entries(&[
            ("Greeting".to_owned(), FiberState::Active),
            ("announce".to_owned(), FiberState::Active),
        ]);
        assert_eq!(
            text,
            "heddle: 2 plugin(s) loaded\n  Greeting         1 fiber(s)  active\n  announce         1 fiber(s)  active\n"
        );
    }

    #[test]
    fn a_label_longer_than_the_column_is_not_cut() {
        let text = describe_entries(&[("console-exporter".to_owned(), FiberState::Active)]);
        assert_eq!(
            text,
            "heddle: 1 plugin(s) loaded\n  console-exporter 1 fiber(s)  active\n"
        );
    }
}
