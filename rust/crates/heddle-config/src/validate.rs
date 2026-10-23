//! Validation without starting anything: `heddle config --validate`.
//!
//! Ported from `src/config/validate.ts`. The claim is narrow: **a bad configuration fails where it is
//! written**, naming the row and the field. Starting a tree to discover a typo means the failure arrives
//! as a component that started but misbehaved, or not at all — and neither names the field.
//!
//! The TypeScript build imported each row's module to find its schema. The Rust binary has no modules;
//! a row names a built-in or an outside component (`rust/ULTIMATE_GOAL.md`, part 0), so where a schema
//! comes from is a [`ComponentCatalog`] the binary assembles — its built-ins, and outside components'
//! declared schemas — and this module only walks the rows and reports.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::compose::{ComponentName, EntryRow};
use crate::env::Env;
use crate::error::ConfigError;
use crate::layer::{NamedLayer, anchor_dir};
use crate::schema::Schema;
use crate::value::LayerValue;

/// What a catalog knows about the component a row names.
#[derive(Clone, Debug, PartialEq)]
pub enum SchemaLookup {
    /// The component's configuration schema.
    Schema(Box<Schema>),
    /// The component exists and declares no schema — not a problem, because a component may take no
    /// configuration, and calling it one would fail correct trees.
    NoSchema,
    /// The row names nothing the catalog can find; the string says why, for the problem
    /// `{label}: cannot resolve the component '{name}' — {why}`.
    Unresolvable(String),
}

/// Where component schemas come from. The binary implements it over its built-ins and the outside
/// components a profile declares; a test implements it with a [`StaticCatalog`].
pub trait ComponentCatalog {
    /// What is known about the component `row` names. `anchor` is the directory relative names resolve
    /// against ([`crate::anchor_dir`]), or `None` when every layer was supplied in memory.
    fn lookup(&self, row: &EntryRow, anchor: Option<&Path>) -> SchemaLookup;
}

/// A catalog that answers from a fixed table of names, for tests and for a binary with only built-ins.
/// A row's `name` is looked up exactly as written.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticCatalog {
    entries: BTreeMap<String, Option<Schema>>,
}

impl StaticCatalog {
    /// An empty catalog, in which every name is unresolvable.
    pub fn new() -> Self {
        Self::default()
    }

    /// This catalog with `name` known, declaring `schema` (or none).
    pub fn with(mut self, name: impl Into<String>, schema: Option<Schema>) -> Self {
        self.entries.insert(name.into(), schema);
        self
    }
}

impl ComponentCatalog for StaticCatalog {
    fn lookup(&self, row: &EntryRow, _anchor: Option<&Path>) -> SchemaLookup {
        match self.entries.get(&row.name) {
            Some(Some(schema)) => SchemaLookup::Schema(Box::new(schema.clone())),
            Some(None) => SchemaLookup::NoSchema,
            None => SchemaLookup::Unresolvable("not a known component".to_string()),
        }
    }
}

/// An outside component's manifest, read without starting the component: the part-0 shape a row
/// names as `./alpha.component.yml` beside the profile.
#[derive(Clone, Debug, PartialEq)]
pub struct ComponentManifest {
    /// The program that starts the component (`program:`). `--validate` reads it and never runs it.
    pub program: String,
    /// Its arguments (`args:`), empty when the manifest names none.
    pub args: Vec<String>,
    /// The component's configuration schema, when it declares one.
    pub config: Option<Schema>,
}

/// Read the manifest at `path`.
///
/// Fails naming the path when the file cannot be read, is empty or is not a mapping, when `program` is
/// not a non-empty string, when `args` is not a list of strings, or when `config` is not a JSON Schema
/// or holds an environment reference. An absent `config` is `Ok(None)`: a component may take no
/// configuration. It is the shape developer-five's `OutsideComponentSpec` spells, so one manifest can
/// later serve both `--validate` and the outside-process spec.
pub fn read_component_manifest(path: &Path) -> Result<ComponentManifest, ConfigError> {
    let Some(value) = crate::layer::read_yaml_value(path)? else {
        return Err(ConfigError::one(format!(
            "{} is empty, not a component manifest",
            path.display()
        )));
    };
    let LayerValue::Mapping(fields) = value else {
        return Err(ConfigError::one(format!(
            "{}: a component manifest must be a mapping",
            path.display()
        )));
    };
    let program = match manifest_field(&fields, "program") {
        Some(LayerValue::String(program)) if !program.is_empty() => program.clone(),
        _ => {
            return Err(ConfigError::one(format!(
                "{}: a component manifest needs a 'program' string",
                path.display()
            )));
        }
    };
    let args = match manifest_field(&fields, "args") {
        None => Vec::new(),
        Some(LayerValue::Sequence(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| match item {
                LayerValue::String(arg) => Ok(arg.clone()),
                _ => Err(ConfigError::one(format!(
                    "{}: args[{index}] must be a string",
                    path.display()
                ))),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => {
            return Err(ConfigError::one(format!(
                "{}: 'args' must be a list of strings",
                path.display()
            )));
        }
    };
    let config = match manifest_field(&fields, "config") {
        None => None,
        Some(value) => {
            let json = crate::value::plain_json(value).ok_or_else(|| {
                ConfigError::one(format!(
                    "{}: 'config' cannot hold an environment reference",
                    path.display()
                ))
            })?;
            Some(
                Schema::from_json(json)
                    .map_err(|error| ConfigError::one(format!("{}: {error}", path.display())))?,
            )
        }
    };
    Ok(ComponentManifest {
        program,
        args,
        config,
    })
}

/// The value of `key` in a manifest's mapping.
fn manifest_field<'a>(fields: &'a [(String, LayerValue)], key: &str) -> Option<&'a LayerValue> {
    fields
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

/// A [`ComponentCatalog`] over outside-component manifests: a row naming a path is read as a
/// `.component.yml` manifest beside the profile, with no process started. Built-ins are not here — a
/// binary composes this with its own catalog, or answers [`SchemaLookup::Unresolvable`] for a bare name.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ManifestCatalog;

impl ManifestCatalog {
    /// A catalog over manifests.
    pub fn new() -> Self {
        Self
    }
}

impl ComponentCatalog for ManifestCatalog {
    fn lookup(&self, row: &EntryRow, anchor: Option<&Path>) -> SchemaLookup {
        let Some(anchor) = anchor else {
            return SchemaLookup::Unresolvable(
                "no layer was read from a file, so a relative component name has no directory"
                    .to_string(),
            );
        };
        match row.component(anchor) {
            ComponentName::Bare(name) => {
                SchemaLookup::Unresolvable(format!("'{name}' is not a built-in name"))
            }
            ComponentName::Path(path) => {
                if !path.exists() {
                    return SchemaLookup::Unresolvable(format!(
                        "{} does not exist",
                        path.display()
                    ));
                }
                match read_component_manifest(&path) {
                    Ok(manifest) => match manifest.config {
                        Some(schema) => SchemaLookup::Schema(Box::new(schema)),
                        None => SchemaLookup::NoSchema,
                    },
                    Err(error) => SchemaLookup::Unresolvable(error.problems().join("; ")),
                }
            }
        }
    }
}

/// The outcome of a validation pass. Serializes as `heddle config --validate --json` prints it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ValidationResult {
    /// Every composed row, disabled ones included.
    pub rows: usize,
    /// Rows whose configuration was checked against a schema.
    pub checked: usize,
    /// Every problem, each starting with the row's label (its `id`, else its `name`).
    pub problems: Vec<String>,
}

/// Compose `layers` and check every enabled row's `config` (an absent one as `{}`) against the schema
/// `catalog` gives for it.
///
/// A row whose component cannot be resolved is a problem; a component with no schema is skipped and not
/// counted as checked; every schema problem is reported as `{label}: {problem}`. A composition that
/// fails is the `Err`, exactly as `compose` reports it — validation does not soften it into a problem.
pub fn validate_rows(
    layers: &[NamedLayer],
    env: &Env,
    catalog: &dyn ComponentCatalog,
) -> Result<ValidationResult, ConfigError> {
    let rows = crate::compose::compose(layers, env)?;
    let anchor = anchor_dir(layers);
    let mut problems = Vec::new();
    let mut checked = 0;

    for composed in &rows {
        let row = &composed.row;
        if row.disabled == Some(true) {
            continue;
        }
        match catalog.lookup(row, anchor.as_deref()) {
            // A component that declares no configuration is not a problem, and is not "checked":
            // counting it would claim a check that never happened.
            SchemaLookup::NoSchema => {}
            SchemaLookup::Unresolvable(why) => problems.push(format!(
                "{}: cannot resolve the component '{}' — {why}",
                row.label(),
                row.name
            )),
            SchemaLookup::Schema(schema) => {
                checked += 1;
                let config = row
                    .config
                    .clone()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                for problem in schema.check(&config) {
                    problems.push(format!("{}: {problem}", row.label()));
                }
            }
        }
    }

    Ok(ValidationResult {
        rows: rows.len(),
        checked,
        problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_static_catalog_tells_known_from_unknown() {
        let catalog = StaticCatalog::new()
            .with("alpha", Some(Schema::default()))
            .with("plain", None);
        let row = |name: &str| EntryRow {
            name: name.into(),
            ..EntryRow::default()
        };
        assert_eq!(
            catalog.lookup(&row("alpha"), None),
            SchemaLookup::Schema(Box::default())
        );
        assert_eq!(catalog.lookup(&row("plain"), None), SchemaLookup::NoSchema);
        assert!(matches!(
            catalog.lookup(&row("nowhere"), None),
            SchemaLookup::Unresolvable(_)
        ));
    }

    use crate::layer::Layer;
    use crate::value::LayerValue;
    use serde_json::json;

    fn layers(insert: Vec<Value>) -> Vec<NamedLayer> {
        vec![NamedLayer {
            layer: "dev/heddle.patch.yml".into(),
            file: "/p/dev/heddle.patch.yml".into(),
            entries: vec![Layer {
                insert: insert.into_iter().map(LayerValue::from).collect(),
                ..Layer::default()
            }],
        }]
    }

    fn alpha_schema() -> Schema {
        Schema::from_json(json!({
            "type": "object",
            "properties": { "count": { "type": "number" } }
        }))
        .unwrap()
    }

    #[test]
    fn a_bad_value_names_the_row_and_the_field() {
        let catalog = StaticCatalog::new().with("alpha", Some(alpha_schema()));
        let result = validate_rows(
            &layers(vec![json!({
                "id": "alpha",
                "name": "alpha",
                "config": { "count": "not-a-number" }
            })]),
            &Env::default(),
            &catalog,
        )
        .unwrap();
        assert_eq!(result.rows, 1);
        assert_eq!(result.checked, 1);
        assert_eq!(
            result.problems,
            [
                "alpha: count is not a number, which means the value in the layer could not be read as one"
            ]
        );
    }

    #[test]
    fn a_disabled_row_is_skipped_and_a_schema_less_component_is_not_counted() {
        let catalog = StaticCatalog::new()
            .with("alpha", Some(alpha_schema()))
            .with("plain", None);
        let result = validate_rows(
            &layers(vec![
                json!({
                    "id": "alpha",
                    "name": "alpha",
                    "disabled": true,
                    "config": { "count": "not-a-number" }
                }),
                json!({ "id": "plain", "name": "plain", "config": { "anything": true } }),
            ]),
            &Env::default(),
            &catalog,
        )
        .unwrap();
        assert_eq!((result.rows, result.checked), (2, 0));
        assert!(result.problems.is_empty());
    }

    #[test]
    fn an_unresolvable_component_is_a_problem() {
        let result = validate_rows(
            &layers(vec![json!({ "id": "alpha", "name": "./alpha" })]),
            &Env::default(),
            &StaticCatalog::new(),
        )
        .unwrap();
        assert_eq!(
            result.problems,
            ["alpha: cannot resolve the component './alpha' — not a known component"]
        );
        assert_eq!(result.checked, 0);
    }

    #[test]
    fn an_absent_config_is_checked_as_an_empty_mapping() {
        let catalog = StaticCatalog::new().with(
            "alpha",
            Some(
                Schema::from_json(json!({
                    "type": "object",
                    "required": ["label"],
                    "properties": { "label": { "type": "string" } }
                }))
                .unwrap(),
            ),
        );
        let result = validate_rows(
            &layers(vec![json!({ "id": "alpha", "name": "alpha" })]),
            &Env::default(),
            &catalog,
        )
        .unwrap();
        assert_eq!(result.problems, ["alpha: label is required"]);
    }

    #[test]
    fn a_composition_failure_is_the_error_rather_than_a_problem() {
        let mut fixture = layers(Vec::new());
        fixture[0].entries[0]
            .patch
            .push(LayerValue::from(json!({ "id": "nowhere", "config": {} })));
        let error = validate_rows(&fixture, &Env::default(), &StaticCatalog::new()).unwrap_err();
        assert!(error.problems()[0].contains("nowhere"));
    }

    #[test]
    fn the_catalog_is_handed_the_anchor_directory() {
        struct Recording;
        impl ComponentCatalog for Recording {
            fn lookup(&self, _row: &EntryRow, anchor: Option<&Path>) -> SchemaLookup {
                assert_eq!(anchor, Some(Path::new("/p/dev")));
                SchemaLookup::NoSchema
            }
        }
        validate_rows(
            &layers(vec![json!({ "id": "alpha", "name": "./alpha" })]),
            &Env::default(),
            &Recording,
        )
        .unwrap();
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "heddle-config-manifest-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    const MANIFEST: &str = "program: ./alpha.ts\nargs:\n  - --serve\nconfig:\n  type: object\n  properties:\n    count:\n      type: number\n";

    #[test]
    fn a_manifest_is_read_without_starting_anything() {
        let root = scratch("read");
        let path = root.join("alpha.component.yml");
        write_text(&path, MANIFEST);
        let manifest = read_component_manifest(&path).unwrap();
        assert_eq!(manifest.program, "./alpha.ts");
        assert_eq!(manifest.args, ["--serve"]);
        let schema = manifest.config.unwrap();
        assert_eq!(
            schema.check(&json!({ "count": "not-a-number" }))[0].to_string(),
            "count is not a number, which means the value in the layer could not be read as one"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_manifest_without_config_is_no_schema() {
        let root = scratch("no-schema");
        let path = root.join("plain.component.yml");
        write_text(&path, "program: ./plain\n");
        let manifest = read_component_manifest(&path).unwrap();
        assert_eq!(manifest.config, None);
        assert!(manifest.args.is_empty());
        let row = EntryRow {
            name: "./plain.component.yml".into(),
            ..EntryRow::default()
        };
        assert_eq!(
            ManifestCatalog::new().lookup(&row, Some(&root)),
            SchemaLookup::NoSchema
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_manifest_that_is_not_a_manifest_names_the_problem() {
        let root = scratch("broken");
        let path = root.join("broken.component.yml");
        write_text(&path, "config:\n  type: object\n");
        let error = read_component_manifest(&path).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: a component manifest needs a 'program' string",
                path.display()
            )]
        );

        write_text(&path, "program: ./x\nargs: [1]\n");
        let error = read_component_manifest(&path).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!("{}: args[0] must be a string", path.display())]
        );

        write_text(&path, "program: ./x\nargs: 1\n");
        let error = read_component_manifest(&path).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: 'args' must be a list of strings",
                path.display()
            )]
        );

        write_text(&path, "program: ./x\nconfig: [not, a, mapping]\n");
        let error = read_component_manifest(&path).unwrap_err();
        assert!(error.problems()[0].contains("not a configuration schema"));

        let row = EntryRow {
            name: "./broken.component.yml".into(),
            ..EntryRow::default()
        };
        match ManifestCatalog::new().lookup(&row, Some(&root)) {
            SchemaLookup::Unresolvable(why) => assert!(why.contains("not a configuration schema")),
            other => panic!("expected an unresolvable component, got {other:?}"),
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_manifest_catalog_resolves_a_relative_row_against_the_anchor() {
        let root = scratch("catalog");
        write_text(&root.join("alpha.component.yml"), MANIFEST);
        let row = EntryRow {
            name: "./alpha.component.yml".into(),
            ..EntryRow::default()
        };
        assert!(matches!(
            ManifestCatalog::new().lookup(&row, Some(&root)),
            SchemaLookup::Schema(_)
        ));

        let bare = EntryRow {
            name: "model".into(),
            ..EntryRow::default()
        };
        assert!(matches!(
            ManifestCatalog::new().lookup(&bare, Some(&root)),
            SchemaLookup::Unresolvable(_)
        ));
        let missing = EntryRow {
            name: "./missing.component.yml".into(),
            ..EntryRow::default()
        };
        assert!(matches!(
            ManifestCatalog::new().lookup(&missing, Some(&root)),
            SchemaLookup::Unresolvable(_)
        ));
        assert!(matches!(
            ManifestCatalog::new().lookup(&row, None),
            SchemaLookup::Unresolvable(_)
        ));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_end_to_end_manifest_validation_names_the_row_and_the_field() {
        let root = scratch("end-to-end");
        let layer_file = root.join("dev/heddle.patch.yml");
        write_text(&layer_file, "[]\n");
        write_text(&root.join("dev/alpha.component.yml"), MANIFEST);
        let fixture = vec![NamedLayer {
            layer: "dev/heddle.patch.yml".into(),
            file: layer_file.to_string_lossy().into_owned(),
            entries: vec![Layer {
                insert: vec![LayerValue::from(json!({
                    "id": "alpha",
                    "name": "./alpha.component.yml",
                    "config": { "count": "not-a-number" }
                }))],
                ..Layer::default()
            }],
        }];
        let result = validate_rows(&fixture, &Env::default(), &ManifestCatalog::new()).unwrap();
        assert_eq!(result.rows, 1);
        assert_eq!(result.checked, 1);
        assert_eq!(
            result.problems,
            [
                "alpha: count is not a number, which means the value in the layer could not be read as one"
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
