//! Composition: named layers folded into rows, the last write winning, with provenance kept.
//!
//! Ported from `EntryRow`, `Provenance`, `ComposedRow`, `compose`, `provenanceOf` and `originOf` in
//! `src/config/schema.ts`. The model is DSH's:
//!
//! - **The base tree is empty.** A profile's `cordis.yml` is `[]`; the tree arrives as patch layers.
//! - **Rows are addressed by `id`.** A later layer restates a row's fields; a patch **replaces** each
//!   field it names (a restated `config` is the whole `config`), so no value is spread across two
//!   layers where neither is readable on its own.
//! - **Row order carries no load semantics.** Activation follows service availability; the order is
//!   for a reader, and `position` records it.
//!
//! Three rules exist because their absence caused a real failure: a missing environment reference is
//! an error; a patch or remove naming a row no earlier layer inserted fails **where it is written**;
//! and a bad row fails naming the row and the field. Composition collects **every** problem before it
//! fails, so one run reports all of them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::env::Env;
use crate::error::ConfigError;
use crate::layer::NamedLayer;

/// One configured component row.
///
/// Serialized with the keys the TypeScript row had; a key no field here names is kept in `extra` and
/// printed back, because the TypeScript build spread the whole row into `heddle config --json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EntryRow {
    /// The address later layers use. A row without one can be inserted but never patched or removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// What the row starts: a built-in's name, or a path to an outside component. See
    /// [`EntryRow::component`].
    pub name: String,
    /// The component's own configuration, checked against its schema by [`crate::validate_rows`] and
    /// handed to the component when it starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    /// The row is a group of rows (DSH's `group`), carried through untouched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<bool>,
    /// The row is present but not started — what `remove` sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    /// The services the row waits for before it starts. `inject: null` reads as absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inject: Option<Vec<String>>,
    /// Any other key the layer wrote on the row, in written order.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// What a row's `name` refers to, once the anchor directory is known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComponentName {
    /// A bare name such as `model` — a built-in the binary registers.
    Bare(String),
    /// A name starting with `.` or `/`, resolved against the anchor directory — an outside component
    /// (or, in a profile written for the TypeScript build, a module path the binary maps to a built-in).
    Path(PathBuf),
}

impl EntryRow {
    /// The label a problem names this row by: its `id`, else its `name`.
    pub fn label(&self) -> &str {
        self.id.as_deref().unwrap_or(&self.name)
    }

    /// What this row's `name` refers to: a [`ComponentName::Path`] for a name starting with `.` or `/`
    /// (resolved lexically against `anchor`, which is [`crate::anchor_dir`] of the layers), a
    /// [`ComponentName::Bare`] otherwise — the same test `boot` applied before handing a name to the
    /// loader.
    pub fn component(&self, anchor: &Path) -> ComponentName {
        let _ = anchor;
        todo!("heddle-config: EntryRow::component")
    }
}

/// Which layer supplied one field of one row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    /// The layer, named as a person would name it (`dev/heddle.patch.yml`, an absolute `--patch`).
    pub layer: String,
    /// The absolute file, or [`crate::INLINE_FILE`] for a layer supplied in memory.
    pub file: String,
    /// The field path within the row, `config.transport.timeoutMs` style. A sequence is one leaf; an
    /// empty mapping has no leaves and so no entry.
    pub field: String,
}

/// A composed row: the row itself, where it was inserted, and where each of its leaf fields came from.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ComposedRow {
    /// The row after every layer.
    pub row: EntryRow,
    /// The index at which the row was inserted, which no later layer changes.
    pub position: usize,
    /// One entry per leaf field, the winning layer's. A patch drops the entries of every top-level
    /// field it restates and adds its own; a remove appends `disabled`.
    pub fields: Vec<Provenance>,
}

impl ComposedRow {
    /// The shape `heddle config --json` prints for this row: the row's own keys, then `position`, then
    /// `origins` (the `fields`, each `{ layer, file, field }`).
    pub fn to_report(&self) -> Value {
        todo!("heddle-config: ComposedRow::to_report")
    }
}

/// Fold `layers`, in order, into rows.
///
/// Per layer entry, in order: every `insert` adds a row (it needs a string `name`; an `id` inserted
/// twice is refused with "use patch to restate it"); every `patch` restates the fields it names on the
/// row its `id` addresses; every `remove` marks the row it names `disabled`. References are resolved per
/// row with `env`, and a problem names the file and the entry index
/// (`{file}: layer {n}: patch names 'nowhere', which no earlier layer inserted`). Every problem is
/// collected, then all are returned together.
pub fn compose(layers: &[NamedLayer], env: &Env) -> Result<Vec<ComposedRow>, ConfigError> {
    let _ = (layers, env);
    todo!("heddle-config: compose")
}

/// Where one field of the row with this `id` came from, or `None` when nothing set it.
///
/// An exact field path wins; otherwise the first entry beneath it answers, so asking for `config`
/// answers with whichever layer supplied a field under `config`.
pub fn origin_of<'a>(rows: &'a [ComposedRow], id: &str, field: &str) -> Option<&'a Provenance> {
    let _ = (rows, id, field);
    todo!("heddle-config: origin_of")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_row_serializes_with_its_written_keys_and_keeps_unknown_ones() {
        let row: EntryRow = serde_json::from_value(json!({
            "id": "alpha", "name": "./alpha", "config": { "label": "x" }, "note": "kept"
        }))
        .unwrap();
        assert_eq!(row.label(), "alpha");
        assert_eq!(row.extra.get("note"), Some(&json!("kept")));
        let back = serde_json::to_value(&row).unwrap();
        assert_eq!(
            back,
            json!({ "id": "alpha", "name": "./alpha", "config": { "label": "x" }, "note": "kept" })
        );
    }

    #[test]
    fn a_row_without_an_id_is_labelled_by_its_name() {
        let row = EntryRow {
            name: "model".into(),
            ..EntryRow::default()
        };
        assert_eq!(row.label(), "model");
    }
}
