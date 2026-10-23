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

use crate::builtins::{Catalog, ComponentRef};
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
    let _ = (options, catalog);
    todo!(
        "port boot() from src/boot.ts over default_layers, compose and anchor_dir of heddle-config"
    )
}

/// Start the rows: the loader. Disabled rows get no entry; every other row gets one, started as soon as
/// what it requires is provided, repeatedly, until nothing more can start.
pub fn load(rows: Vec<ComposedRow>, anchor: &Path, catalog: &dyn Catalog) -> Boot {
    let _ = (rows, anchor, catalog);
    todo!("start each ready entry until a fixed point; unready entries stay pending")
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

impl Boot {
    /// Stop every started entry in reverse order and withdraw what it provided: `ctx.fiber.dispose()`.
    pub fn dispose(self) {
        todo!("dispose entries in reverse creation order")
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
