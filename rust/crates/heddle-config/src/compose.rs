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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::env::Env;
use crate::error::ConfigError;
use crate::layer::NamedLayer;
use crate::paths::resolve;
use crate::references::resolve_env;
use crate::value::LayerValue;

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
        let name = Path::new(&self.name);
        if self.name.starts_with('.') || name.is_absolute() {
            ComponentName::Path(resolve(anchor, name))
        } else {
            ComponentName::Bare(self.name.clone())
        }
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
        let mut report = match serde_json::to_value(&self.row) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        // A row that wrote `config: null` composes to no config, so the loader hands `{}`; but the
        // TypeScript row kept the null and printed it. The written null leaves a `config` origin,
        // which an absent config does not, so print it back in the row's own place, after `name`.
        if self.row.config.is_none() && self.fields.iter().any(|field| field.field == "config") {
            let mut with_null = Map::new();
            for (key, value) in report {
                let after_name = key == "name";
                with_null.insert(key, value);
                if after_name {
                    with_null.insert("config".into(), Value::Null);
                }
            }
            report = with_null;
        }
        report.insert("position".into(), Value::from(self.position));
        report.insert(
            "origins".into(),
            serde_json::to_value(&self.fields).unwrap_or(Value::Null),
        );
        Value::Object(report)
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
    let mut rows: Vec<ComposedRow> = Vec::new();
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    let mut problems: Vec<String> = Vec::new();

    for named in layers {
        for (layer_index, layer) in named.entries.iter().enumerate() {
            for raw in &layer.insert {
                if !matches!(raw.get("name"), Some(LayerValue::String(_))) {
                    problems.push(format!(
                        "{}: layer {layer_index}: every inserted row needs a name",
                        named.file
                    ));
                    continue;
                }
                let mut id: Option<String> = None;
                match raw.get("id") {
                    None => {}
                    Some(LayerValue::String(claimed)) => {
                        if index.contains_key(claimed) {
                            problems.push(format!(
                                "{}: layer {layer_index}: '{claimed}' is inserted twice; use patch to restate it",
                                named.file
                            ));
                            continue;
                        }
                        id = Some(claimed.clone());
                    }
                    Some(_) => {
                        problems.push(format!(
                            "{}: layer {layer_index}: a row's 'id' must be a string",
                            named.file
                        ));
                        continue;
                    }
                }
                let row = match resolved_row(raw, &named.file, env, &problems_label(raw)) {
                    Ok(row) => row,
                    Err(problem) => {
                        problems.push(problem);
                        continue;
                    }
                };
                let position = rows.len();
                if let Some(claimed) = id {
                    index.insert(claimed, position);
                }
                rows.push(ComposedRow {
                    row,
                    position,
                    fields: provenance_of(raw, &named.layer, &named.file),
                });
            }

            for edit in &layer.patch {
                let Some(id) = edit.get("id").and_then(LayerValue::as_str) else {
                    problems.push(format!(
                        "{}: layer {layer_index}: every patched row needs an id",
                        named.file
                    ));
                    continue;
                };
                let Some(&at) = index.get(id) else {
                    problems.push(format!(
                        "{}: layer {layer_index}: patch names '{id}', which no earlier layer inserted",
                        named.file
                    ));
                    continue;
                };
                let resolved = match resolve_env(edit, &named.file, env) {
                    Ok(resolved) => resolved,
                    Err(error) => {
                        problems.extend(error.into_problems());
                        continue;
                    }
                };
                let Value::Object(restated) = resolved else {
                    continue;
                };
                let mut merged = match serde_json::to_value(&rows[at].row) {
                    Ok(Value::Object(map)) => map,
                    _ => Map::new(),
                };
                let mut replaced: Vec<String> = Vec::new();
                for (key, value) in restated {
                    if key == "id" {
                        continue;
                    }
                    replaced.push(key.clone());
                    merged.insert(key, value);
                }
                let row: EntryRow = match serde_json::from_value(Value::Object(merged)) {
                    Ok(row) => row,
                    Err(error) => {
                        problems.push(format!(
                            "{}: layer {layer_index}: row '{id}' could not be read: {error}",
                            named.file
                        ));
                        continue;
                    }
                };
                // A patch's fields supersede the older provenance for exactly those top-level fields.
                let mut fields: Vec<Provenance> = rows[at]
                    .fields
                    .iter()
                    .filter(|entry| {
                        let top = entry.field.split('.').next().unwrap_or_default();
                        !replaced.iter().any(|key| key == top)
                    })
                    .cloned()
                    .collect();
                fields.extend(
                    provenance_of(edit, &named.layer, &named.file)
                        .into_iter()
                        .filter(|entry| entry.field != "id"),
                );
                rows[at] = ComposedRow {
                    row,
                    position: rows[at].position,
                    fields,
                };
            }

            for item in &layer.remove {
                let id = scalar_text(item);
                let Some(&at) = index.get(&id) else {
                    problems.push(format!(
                        "{}: layer {layer_index}: remove names '{id}', which no earlier layer inserted",
                        named.file
                    ));
                    continue;
                };
                rows[at].row.disabled = Some(true);
                rows[at].fields.push(Provenance {
                    layer: named.layer.clone(),
                    file: named.file.clone(),
                    field: "disabled".into(),
                });
            }
        }
    }

    if problems.is_empty() {
        Ok(rows)
    } else {
        Err(ConfigError::new(problems))
    }
}

/// Resolve one row value and read it as an [`EntryRow`], naming the row in a problem.
fn resolved_row(raw: &LayerValue, file: &str, env: &Env, label: &str) -> Result<EntryRow, String> {
    let resolved = resolve_env(raw, file, env).map_err(|error| error.problems().join("\n"))?;
    serde_json::from_value(resolved)
        .map_err(|error| format!("{file}: row '{label}' could not be read: {error}"))
}

/// What a problem calls a row that may not have an id: its id, else its name, else `?`.
fn problems_label(raw: &LayerValue) -> String {
    if let Some(LayerValue::String(id)) = raw.get("id") {
        return id.clone();
    }
    raw.get("name")
        .and_then(LayerValue::as_str)
        .unwrap_or("?")
        .to_string()
}

/// One provenance entry per leaf field of a partial row, in written order.
///
/// An object is walked into; a sequence, an `!env` marker, an `!include` marker and every scalar are
/// leaves. An empty object has no leaves and so contributes nothing.
fn provenance_of(value: &LayerValue, layer: &str, file: &str) -> Vec<Provenance> {
    fn walk(node: &LayerValue, path: &str, layer: &str, file: &str, out: &mut Vec<Provenance>) {
        if let LayerValue::Mapping(entries) = node {
            for (key, child) in entries {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                walk(child, &child_path, layer, file, out);
            }
            return;
        }
        out.push(Provenance {
            layer: layer.to_string(),
            file: file.to_string(),
            field: path.to_string(),
        });
    }
    let mut entries = Vec::new();
    walk(value, "", layer, file, &mut entries);
    entries
}

/// How a `remove` entry that is not a string is written back into the problem, as JavaScript's
/// template string wrote it.
fn scalar_text(value: &LayerValue) -> String {
    match value {
        LayerValue::String(text) => text.clone(),
        LayerValue::Null => "null".into(),
        LayerValue::Bool(flag) => flag.to_string(),
        LayerValue::Number(number) => number.to_string(),
        other => crate::value::plain_json(other)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "(a reference)".into()),
    }
}

/// Where one field of the row with this `id` came from, or `None` when nothing set it.
///
/// An exact field path wins; otherwise the first entry beneath it answers, so asking for `config`
/// answers with whichever layer supplied a field under `config`.
pub fn origin_of<'a>(rows: &'a [ComposedRow], id: &str, field: &str) -> Option<&'a Provenance> {
    let composed = rows
        .iter()
        .find(|entry| entry.row.id.as_deref() == Some(id))?;
    composed
        .fields
        .iter()
        .find(|entry| entry.field == field)
        .or_else(|| {
            composed.fields.iter().find(|entry| {
                entry
                    .field
                    .strip_prefix(field)
                    .is_some_and(|rest| rest.starts_with('.'))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn named(layer: &str, file: &str, entries: Vec<LayerValue>) -> NamedLayer {
        NamedLayer {
            layer: layer.into(),
            file: file.into(),
            entries: entries
                .into_iter()
                .map(|entry| match entry {
                    LayerValue::Mapping(fields) => {
                        let mut layer = crate::layer::Layer::default();
                        for (key, value) in fields {
                            match key.as_str() {
                                "insert" => {
                                    layer.insert = sequence(value);
                                }
                                "patch" => layer.patch = sequence(value),
                                "remove" => layer.remove = sequence(value),
                                _ => panic!("unknown layer key {key}"),
                            }
                        }
                        layer
                    }
                    _ => panic!("a layer entry is a mapping"),
                })
                .collect(),
        }
    }

    fn sequence(value: LayerValue) -> Vec<LayerValue> {
        match value {
            LayerValue::Sequence(items) => items,
            other => vec![other],
        }
    }

    fn insert(id: &str, name: &str, config: Value) -> LayerValue {
        LayerValue::from(json!({ "insert": [{ "id": id, "name": name, "config": config }] }))
    }

    fn patch(id: &str, config: Value) -> LayerValue {
        LayerValue::from(json!({ "patch": [{ "id": id, "config": config }] }))
    }

    fn remove(id: &str) -> LayerValue {
        LayerValue::from(json!({ "remove": [id] }))
    }

    fn env() -> Env {
        Env::from_pairs([("LABEL", "from-the-environment")])
    }

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

    #[test]
    fn the_last_layer_wins_and_the_untouched_fields_keep_their_origin() {
        let layers = vec![
            named(
                "base/heddle.patch.yml",
                "/p/base/heddle.patch.yml",
                vec![insert("alpha", "./alpha", json!({ "label": "base" }))],
            ),
            named(
                "restate/heddle.patch.yml",
                "/p/restate/heddle.patch.yml",
                vec![patch("alpha", json!({ "label": "later" }))],
            ),
        ];
        let rows = compose(&layers, &env()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].row.config, Some(json!({ "label": "later" })));
        assert_eq!(
            origin_of(&rows, "alpha", "config.label").map(|p| p.layer.as_str()),
            Some("restate/heddle.patch.yml")
        );
        assert_eq!(
            origin_of(&rows, "alpha", "name").map(|p| p.layer.as_str()),
            Some("base/heddle.patch.yml"),
            "a field no later layer touched keeps its original layer"
        );
    }

    #[test]
    fn a_patch_replaces_config_whole_rather_than_merging_it() {
        let layers = vec![
            named(
                "base.yml",
                "/p/base.yml",
                vec![insert(
                    "alpha",
                    "./alpha",
                    json!({ "label": "x", "count": 1 }),
                )],
            ),
            named(
                "restate.yml",
                "/p/restate.yml",
                vec![patch("alpha", json!({ "label": "y" }))],
            ),
        ];
        let rows = compose(&layers, &env()).unwrap();
        assert_eq!(rows[0].row.config, Some(json!({ "label": "y" })));
        assert!(
            origin_of(&rows, "alpha", "config.count").is_none(),
            "the replaced field's old provenance is dropped"
        );
        assert_eq!(
            origin_of(&rows, "alpha", "config.label").map(|p| p.layer.as_str()),
            Some("restate.yml")
        );
    }

    #[test]
    fn a_remove_keeps_the_row_visible_and_marks_it_disabled() {
        let layers = vec![
            named(
                "base.yml",
                "/p/base.yml",
                vec![insert("alpha", "./alpha", json!({ "label": "x" }))],
            ),
            named("gone.yml", "/p/gone.yml", vec![remove("alpha")]),
        ];
        let rows = compose(&layers, &env()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].row.disabled, Some(true));
        assert_eq!(
            origin_of(&rows, "alpha", "disabled").map(|p| p.layer.as_str()),
            Some("gone.yml")
        );
    }

    #[test]
    fn an_id_inserted_twice_is_refused() {
        let layers = vec![named(
            "base.yml",
            "/p/base.yml",
            vec![LayerValue::from(json!({
                "insert": [
                    { "id": "alpha", "name": "./alpha" },
                    { "id": "alpha", "name": "./other" }
                ]
            }))],
        )];
        let error = compose(&layers, &env()).unwrap_err();
        assert_eq!(
            error.problems(),
            ["/p/base.yml: layer 0: 'alpha' is inserted twice; use patch to restate it"]
        );
    }

    #[test]
    fn a_patch_or_remove_of_a_missing_row_fails_where_it_is_written() {
        let layers = vec![named(
            "base.yml",
            "/p/base.yml",
            vec![LayerValue::from(json!({
                "patch": [{ "id": "nowhere", "config": {} }],
                "remove": ["gone"]
            }))],
        )];
        let error = compose(&layers, &env()).unwrap_err();
        assert_eq!(
            error.problems(),
            [
                "/p/base.yml: layer 0: patch names 'nowhere', which no earlier layer inserted",
                "/p/base.yml: layer 0: remove names 'gone', which no earlier layer inserted",
            ]
        );
    }

    #[test]
    fn every_problem_is_collected_before_the_composition_fails() {
        let layers = vec![named(
            "mixed.yml",
            "/p/mixed.yml",
            vec![
                LayerValue::from(json!({ "insert": [{ "id": "no-name" }] })),
                patch("nowhere", json!({})),
                LayerValue::from(json!({ "insert": [{ "id": 7, "name": "./x" }] })),
            ],
        )];
        let error = compose(&layers, &env()).unwrap_err();
        assert_eq!(error.problems().len(), 3);
        assert!(error.problems()[0].contains("every inserted row needs a name"));
        assert!(error.problems()[1].contains("patch names 'nowhere'"));
        assert!(error.problems()[2].contains("'id' must be a string"));
    }

    #[test]
    fn a_row_that_writes_no_config_prints_no_config_key() {
        let layers = vec![named(
            "base.yml",
            "/p/base.yml",
            vec![LayerValue::from(
                json!({ "insert": [{ "id": "a", "name": "./a" }] }),
            )],
        )];
        let rows = compose(&layers, &env()).unwrap();
        assert!(
            rows[0].to_report().get("config").is_none(),
            "only a written `config: null` is printed back; an absent config stays absent"
        );
    }

    #[test]
    fn a_config_written_as_null_reads_as_no_config() {
        // The loader hands a component `{}` for a row with no config; it can only do that if absent
        // and `null` compose to the same thing, so both are `None` here.
        let alpha = LayerValue::Mapping(vec![
            ("id".into(), LayerValue::String("alpha".into())),
            ("name".into(), LayerValue::String("./alpha".into())),
            ("config".into(), LayerValue::Null),
        ]);
        let layers = vec![
            NamedLayer {
                layer: "base.yml".into(),
                file: "/p/base.yml".into(),
                entries: vec![crate::layer::Layer {
                    insert: vec![
                        alpha,
                        LayerValue::from(
                            json!({ "id": "beta", "name": "./beta", "config": { "x": 1 } }),
                        ),
                    ],
                    ..crate::layer::Layer::default()
                }],
            },
            named(
                "clear.yml",
                "/p/clear.yml",
                vec![LayerValue::from(
                    json!({ "patch": [{ "id": "beta", "config": null }] }),
                )],
            ),
        ];
        let rows = compose(&layers, &env()).unwrap();
        assert_eq!(
            rows[0].row.config, None,
            "an inserted `config: null` is no config"
        );
        assert_eq!(
            rows[1].row.config, None,
            "a patched `config: null` clears the config"
        );
        for (at, how) in [(0, "an inserted"), (1, "a patched")] {
            let report = rows[at].to_report();
            assert_eq!(
                report.get("config"),
                Some(&Value::Null),
                "{how} `config: null` is printed back by `config --json`, as the TypeScript row kept it"
            );
            let keys: Vec<&str> = report
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(
                &keys[..3],
                ["id", "name", "config"],
                "in the row's own place"
            );
        }
        assert_eq!(
            origin_of(&rows, "beta", "config").map(|p| p.layer.as_str()),
            Some("clear.yml"),
            "the patch that cleared it is where the config came from"
        );
        assert!(
            origin_of(&rows, "beta", "config.x").is_none(),
            "the replaced field's old provenance is gone"
        );
    }

    #[test]
    fn an_inserted_row_may_have_no_id_and_is_then_unaddressable() {
        let layers = vec![named(
            "base.yml",
            "/p/base.yml",
            vec![LayerValue::from(
                json!({ "insert": [{ "name": "./alpha" }] }),
            )],
        )];
        let rows = compose(&layers, &env()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].row.id, None);
        assert_eq!(rows[0].row.name, "./alpha");
    }

    #[test]
    fn references_are_resolved_while_provenance_names_the_written_field() {
        // A row carrying an `!env` marker cannot be spelled with `json!`, so build it as a layer value.
        let row = LayerValue::Mapping(vec![
            ("id".into(), LayerValue::String("alpha".into())),
            ("name".into(), LayerValue::String("./alpha".into())),
            (
                "config".into(),
                LayerValue::Mapping(vec![("label".into(), LayerValue::Env("LABEL".into()))]),
            ),
        ]);
        let layers = vec![NamedLayer {
            layer: "env.yml".into(),
            file: "/p/env.yml".into(),
            entries: vec![crate::layer::Layer {
                insert: vec![row],
                ..crate::layer::Layer::default()
            }],
        }];
        let rows = compose(&layers, &env()).unwrap();
        assert_eq!(
            rows[0].row.config,
            Some(json!({ "label": "from-the-environment" }))
        );
        assert_eq!(
            origin_of(&rows, "alpha", "config.label").map(|p| p.layer.as_str()),
            Some("env.yml")
        );
    }

    #[test]
    fn an_origin_query_for_a_parent_field_answers_with_a_field_beneath_it() {
        let layers = vec![named(
            "base.yml",
            "/p/base.yml",
            vec![insert("alpha", "./alpha", json!({ "label": "x" }))],
        )];
        let rows = compose(&layers, &env()).unwrap();
        assert_eq!(
            origin_of(&rows, "alpha", "config").map(|p| p.field.as_str()),
            Some("config.label")
        );
        assert!(origin_of(&rows, "alpha", "nowhere").is_none());
        assert!(origin_of(&rows, "missing", "config").is_none());
    }

    #[test]
    fn the_report_is_the_row_then_position_then_origins() {
        // Build the row in written order, which is the order provenance must report.
        let row = LayerValue::Mapping(vec![
            ("id".into(), LayerValue::String("alpha".into())),
            ("name".into(), LayerValue::String("./alpha".into())),
            (
                "config".into(),
                LayerValue::Mapping(vec![("label".into(), LayerValue::String("x".into()))]),
            ),
        ]);
        let layers = vec![NamedLayer {
            layer: "base.yml".into(),
            file: "/p/base.yml".into(),
            entries: vec![crate::layer::Layer {
                insert: vec![row],
                ..crate::layer::Layer::default()
            }],
        }];
        let rows = compose(&layers, &env()).unwrap();
        let report = rows[0].to_report();
        assert_eq!(report["id"], json!("alpha"));
        assert_eq!(report["name"], json!("./alpha"));
        assert_eq!(report["config"], json!({ "label": "x" }));
        assert_eq!(report["position"], json!(0));
        assert_eq!(
            report["origins"],
            json!([
                { "layer": "base.yml", "file": "/p/base.yml", "field": "id" },
                { "layer": "base.yml", "file": "/p/base.yml", "field": "name" },
                { "layer": "base.yml", "file": "/p/base.yml", "field": "config.label" },
            ])
        );
    }

    #[test]
    fn a_component_name_is_a_path_only_when_it_starts_with_a_dot_or_a_slash() {
        let row = EntryRow {
            name: "./alpha".into(),
            ..EntryRow::default()
        };
        assert_eq!(
            row.component(Path::new("/p/dev")),
            ComponentName::Path(PathBuf::from("/p/dev/alpha"))
        );
        let absolute = EntryRow {
            name: "/elsewhere/beta".into(),
            ..EntryRow::default()
        };
        assert_eq!(
            absolute.component(Path::new("/p/dev")),
            ComponentName::Path(PathBuf::from("/elsewhere/beta"))
        );
        let bare = EntryRow {
            name: "model".into(),
            ..EntryRow::default()
        };
        assert_eq!(
            bare.component(Path::new("/p/dev")),
            ComponentName::Bare("model".into())
        );
    }
}
