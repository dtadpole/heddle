//! Layers: what one layer file holds, read with its includes expanded.
//!
//! Ported from `Layer`, `NamedLayer` and `readLayer` in `src/config/schema.ts`.
//!
//! A layer file is a YAML array whose entries are mappings of `insert`, `patch`, `remove` and
//! `include`. An `include` names another layer file — one path or a list — resolved relative to the
//! file that names it, and its layers come **before** the entry's own edits. A file that appears twice
//! in the chain being read is a cycle, refused **by path** (`include cycle: a.yml -> b.yml -> a.yml`)
//! rather than by a depth limit, because the useful sentence is which file includes which.

use std::path::{Path, PathBuf};

use saphyr::{LoadableYamlNode, Scalar, Tag, Yaml};
use serde_json::{Number, Value};

use crate::env::Env;
use crate::error::ConfigError;
use crate::home::expand_home;
use crate::paths::resolve_from_cwd;
use crate::value::LayerValue;

/// The `file` of a layer supplied in memory rather than read, as the TypeScript build wrote it.
pub const INLINE_FILE: &str = "(inline)";

/// One entry of a layer file, after its includes are expanded: the rows it inserts, the restatements
/// it patches, and the ids it removes.
///
/// The values are kept as written, references unresolved, because composition is where a row is
/// checked and resolved and where a problem is reported with the layer it came from. A layer file
/// that writes `insert:` as anything but a list fails when it is read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Layer {
    /// Rows to add; each needs a `name`, and a later layer addresses it by its `id`.
    pub insert: Vec<LayerValue>,
    /// Restatements, each with the `id` of a row an earlier layer inserted; the fields it names
    /// replace the row's fields of the same name — a patch replaces, it does not merge.
    pub patch: Vec<LayerValue>,
    /// Ids of rows to disable. A removed row stays in the composition, marked `disabled`.
    pub remove: Vec<LayerValue>,
}

impl Layer {
    /// A layer that patches these rows — how a command-line flag restates one row
    /// (`heddle --session-root DIR` is `patch: [{ id: session, config: { root: DIR } }]`). Each value
    /// is a JSON object with an `id`.
    pub fn patching(rows: impl IntoIterator<Item = Value>) -> Self {
        Self {
            patch: rows.into_iter().map(LayerValue::from).collect(),
            ..Self::default()
        }
    }
}

/// A layer file's entries, with the names a report uses for it.
#[derive(Clone, Debug, PartialEq)]
pub struct NamedLayer {
    /// The layer as a person names it — `dev/heddle.patch.yml` for a profile's file, the absolute path
    /// for a `--patch`, `override 1` for an in-memory layer. Provenance reports this.
    pub layer: String,
    /// The absolute file the layer was read from, or [`INLINE_FILE`]. Problems are reported against it.
    pub file: String,
    /// The file's entries, includes expanded, in order.
    pub entries: Vec<Layer>,
}

impl NamedLayer {
    /// Read `file` (a leading `~` expanded, made absolute) and name it `layer`.
    pub fn read(layer: impl Into<String>, file: &Path, env: &Env) -> Result<Self, ConfigError> {
        let absolute = absolute_path(file, env);
        let entries = read_layer(&absolute, env)?;
        Ok(Self {
            layer: layer.into(),
            file: absolute.to_string_lossy().into_owned(),
            entries,
        })
    }

    /// The `index`-th in-memory layer (counting from 1), named `override {index}` with the file
    /// [`INLINE_FILE`], as `boot` named the layers it was handed.
    pub fn inline(index: usize, layer: Layer) -> Self {
        Self {
            layer: format!("override {index}"),
            file: INLINE_FILE.to_string(),
            entries: vec![layer],
        }
    }
}

/// Read one layer file, expanding includes, and return its entries in order.
///
/// Fails, naming the absolute file, when the file cannot be read, is not YAML, is not a top-level
/// array, has an entry that is not a mapping, has a key other than `insert`, `patch`, `remove` or
/// `include`, has an `include` that is not a path, or includes a file already being read. An empty file
/// is an empty layer. `${NAME}` and `!env NAME` are **not** resolved here; [`crate::compose()`]
/// resolves them per row.
pub fn read_layer(file: &Path, env: &Env) -> Result<Vec<Layer>, ConfigError> {
    read_layer_inner(file, &[], env)
}

/// [`read_layer`] with the chain of files currently being read, which is how a cycle is refused by
/// path rather than by a depth limit.
fn read_layer_inner(file: &Path, stack: &[PathBuf], env: &Env) -> Result<Vec<Layer>, ConfigError> {
    let absolute = absolute_path(file, env);
    if stack.contains(&absolute) {
        let mut chain: Vec<String> = stack
            .iter()
            .map(|path| path.display().to_string())
            .collect();
        chain.push(absolute.display().to_string());
        return Err(ConfigError::one(format!(
            "include cycle: {}",
            chain.join(" -> ")
        )));
    }
    let text = std::fs::read_to_string(&absolute).map_err(|error| {
        ConfigError::one(format!(
            "could not read the layer {}: {error}",
            absolute.display()
        ))
    })?;
    let Some(document) = load_document(&text, &absolute.display().to_string())? else {
        return Ok(Vec::new());
    };
    // A document that is `null` or `~` is no layers, as `src/config/schema.ts` reads it
    // (`if (parsed === null || parsed === undefined) return []`).
    if matches!(document, Yaml::Value(Scalar::Null)) {
        return Ok(Vec::new());
    }
    let Yaml::Sequence(entries) = document else {
        return Err(ConfigError::one(format!(
            "{}: expected a top-level array of layers",
            absolute.display()
        )));
    };

    let mut layers = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let Yaml::Mapping(fields) = entry else {
            return Err(ConfigError::one(format!(
                "{}: layer {index} must be a mapping of insert, patch, remove or include",
                absolute.display()
            )));
        };
        let mut insert = Vec::new();
        let mut patch = Vec::new();
        let mut remove = Vec::new();
        let mut present = false;
        for (key, value) in fields {
            let key = scalar_text(key).unwrap_or_default();
            match key.as_str() {
                "insert" | "patch" | "remove" => {
                    let list = match value {
                        Yaml::Sequence(items) => items
                            .iter()
                            .map(|item| convert(item))
                            .collect::<Result<Vec<_>, _>>()
                            .map_err(|reason| {
                                ConfigError::one(format!("{}: {reason}", absolute.display()))
                            })?,
                        _ => {
                            return Err(ConfigError::one(format!(
                                "{}: layer {index}: {key} must be a list",
                                absolute.display()
                            )));
                        }
                    };
                    match key.as_str() {
                        "insert" => insert = list,
                        "patch" => patch = list,
                        _ => remove = list,
                    }
                    present = true;
                }
                "include" => {
                    let includes = match value {
                        Yaml::Sequence(items) => items.iter().collect::<Vec<_>>(),
                        other => vec![other],
                    };
                    for include in includes {
                        let Some(path) = string_value(include) else {
                            return Err(ConfigError::one(format!(
                                "{}: include must be a path, not {}",
                                absolute.display(),
                                describe(include)
                            )));
                        };
                        let target = Path::new(&path);
                        let target = if target.is_absolute() {
                            target.to_path_buf()
                        } else {
                            absolute
                                .parent()
                                .map(Path::to_path_buf)
                                .unwrap_or_default()
                                .join(target)
                        };
                        let mut chain = stack.to_vec();
                        chain.push(absolute.clone());
                        layers.extend(read_layer_inner(&target, &chain, env)?);
                    }
                }
                other => {
                    return Err(ConfigError::one(format!(
                        "{}: layer {index} has unknown key '{other}'; expected insert, patch, remove or include",
                        absolute.display()
                    )));
                }
            }
        }
        if present {
            layers.push(Layer {
                insert,
                patch,
                remove,
            });
        }
    }
    Ok(layers)
}

/// One YAML document, or `None` for an empty file or an empty document.
fn load_document<'a>(text: &'a str, label: &str) -> Result<Option<Yaml<'a>>, ConfigError> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let documents = Yaml::load_from_str(text)
        .map_err(|error| ConfigError::one(format!("{label} is not valid YAML: {error}")))?;
    if documents.len() > 1 {
        return Err(ConfigError::one(format!(
            "{label}: expected a single YAML document in the stream"
        )));
    }
    Ok(match documents.into_iter().next() {
        None | Some(Yaml::BadValue) => None,
        Some(document) => Some(document),
    })
}

/// Read any YAML file as one [`LayerValue`], for a reader outside the layer-array shape (a component
/// manifest). Crate-internal: the public surface is [`crate::read_component_manifest`].
pub(crate) fn read_yaml_value(path: &Path) -> Result<Option<LayerValue>, ConfigError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| ConfigError::one(format!("could not read {}: {error}", path.display())))?;
    let Some(document) = load_document(&text, &path.display().to_string())? else {
        return Ok(None);
    };
    convert(&document)
        .map(Some)
        .map_err(|reason| ConfigError::one(format!("{}: {reason}", path.display())))
}

/// The file made absolute the way every other layer path is: `~` expanded and resolved against the
/// working directory.
fn absolute_path(file: &Path, env: &Env) -> PathBuf {
    resolve_from_cwd(&expand_home(&file.to_string_lossy(), env))
}

/// One YAML node as a [`LayerValue`], or a reason it cannot be one.
fn convert(node: &Yaml<'_>) -> Result<LayerValue, String> {
    Ok(match node {
        Yaml::Value(scalar) => match scalar {
            Scalar::Null => LayerValue::Null,
            Scalar::Boolean(flag) => LayerValue::Bool(*flag),
            Scalar::Integer(number) => LayerValue::Number(Number::from(*number)),
            Scalar::FloatingPoint(number) => Number::from_f64(number.0)
                .map(LayerValue::Number)
                .ok_or_else(|| {
                    "a floating point value could not be read as a number".to_string()
                })?,
            Scalar::String(text) => LayerValue::String(text.to_string()),
        },
        Yaml::Sequence(items) => {
            LayerValue::Sequence(items.iter().map(convert).collect::<Result<Vec<_>, _>>()?)
        }
        Yaml::Mapping(fields) => LayerValue::Mapping(
            fields
                .iter()
                .map(|(key, value)| {
                    let key = scalar_text(key)
                        .ok_or_else(|| "a mapping key must be a scalar".to_string())?;
                    Ok((key, convert(value)?))
                })
                .collect::<Result<Vec<_>, String>>()?,
        ),
        Yaml::Tagged(tag, inner) => match local_tag(tag) {
            Some("env") => LayerValue::Env(tagged_text(inner, tag)?),
            Some("include") => LayerValue::Include(tagged_text(inner, tag)?),
            _ => return Err(format!("unknown tag '{}'", tag_name(tag))),
        },
        Yaml::Representation(text, _, tag) => match tag.as_deref() {
            Some(tag) => match local_tag(tag) {
                Some("env") => LayerValue::Env(text.to_string()),
                Some("include") => LayerValue::Include(text.to_string()),
                _ => return Err(format!("unknown tag '{}'", tag_name(tag))),
            },
            None => LayerValue::String(text.to_string()),
        },
        Yaml::Alias(_) => return Err("an alias could not be resolved".to_string()),
        Yaml::BadValue => return Err("a value could not be read".to_string()),
    })
}

/// The text of a tagged scalar: a name for `!env`, a path for `!include`.
fn tagged_text(node: &Yaml<'_>, tag: &Tag) -> Result<String, String> {
    if let Yaml::Tagged(inner_tag, inner) = node {
        return tagged_text(inner, inner_tag);
    }
    scalar_text(node).ok_or_else(|| format!("the tag '{}' needs a scalar value", tag_name(tag)))
}

/// A value an `include` may name: a **string** scalar only, as the TypeScript reader required
/// (`typeof include !== 'string'` refused a bare number even though its text could look like a path).
fn string_value(node: &Yaml<'_>) -> Option<String> {
    match node {
        Yaml::Value(Scalar::String(text)) => Some(text.to_string()),
        Yaml::Representation(text, _, tag) if tag.is_none() => Some(text.to_string()),
        _ => None,
    }
}

/// A scalar's text, as YAML wrote it; `None` for a collection or an unresolved node.
fn scalar_text(node: &Yaml<'_>) -> Option<String> {
    match node {
        Yaml::Value(Scalar::String(text)) => Some(text.to_string()),
        Yaml::Value(Scalar::Integer(number)) => Some(number.to_string()),
        Yaml::Value(Scalar::Boolean(flag)) => Some(flag.to_string()),
        Yaml::Value(Scalar::FloatingPoint(number)) => Some(number.0.to_string()),
        Yaml::Value(Scalar::Null) => Some("null".to_string()),
        Yaml::Representation(text, _, _) => Some(text.to_string()),
        _ => None,
    }
}

/// How a node is written in an error, as JavaScript's `JSON.stringify` wrote it.
fn describe(node: &Yaml<'_>) -> String {
    match node {
        Yaml::Value(Scalar::String(text)) => format!("{text:?}"),
        Yaml::Value(scalar) => match scalar {
            Scalar::Null => "null".to_string(),
            Scalar::Boolean(flag) => flag.to_string(),
            Scalar::Integer(number) => number.to_string(),
            Scalar::FloatingPoint(number) => number.0.to_string(),
            Scalar::String(text) => format!("{text:?}"),
        },
        Yaml::Sequence(_) => "a list".to_string(),
        Yaml::Mapping(_) => "a mapping".to_string(),
        _ => "a value".to_string(),
    }
}

/// The suffix of a local tag (`!env` -> `env`); `None` for a tag from another handle.
fn local_tag(tag: &Tag) -> Option<&str> {
    (tag.handle == "!").then_some(tag.suffix.as_str())
}

/// A tag as a document spells it, for an error.
fn tag_name(tag: &Tag) -> String {
    if tag.handle == "!" {
        format!("!{}", tag.suffix)
    } else {
        format!("{}{}", tag.handle, tag.suffix)
    }
}

/// The directory relative component names resolve against: the directory of the first layer that was
/// read from a file. `boot` and `config --validate` both anchor here, so `./alpha` in a profile names
/// a file beside the profile, not one beside the caller's working directory.
pub fn anchor_dir(layers: &[NamedLayer]) -> Option<PathBuf> {
    layers
        .iter()
        .find(|layer| layer.file != INLINE_FILE)
        .and_then(|layer| Path::new(&layer.file).parent().map(Path::to_path_buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_inline_layer_is_named_as_boot_named_it() {
        let named = NamedLayer::inline(1, Layer::patching([json!({ "id": "session" })]));
        assert_eq!(named.layer, "override 1");
        assert_eq!(named.file, INLINE_FILE);
        assert_eq!(named.entries.len(), 1);
        assert_eq!(
            named.entries[0].patch[0]
                .get("id")
                .and_then(LayerValue::as_str),
            Some("session")
        );
    }

    #[test]
    fn the_anchor_is_the_first_files_directory() {
        let inline = NamedLayer::inline(1, Layer::default());
        let file = NamedLayer {
            layer: "dev/heddle.patch.yml".into(),
            file: "/p/dev/heddle.patch.yml".into(),
            entries: Vec::new(),
        };
        assert_eq!(
            anchor_dir(&[inline.clone(), file]),
            Some(PathBuf::from("/p/dev"))
        );
        assert_eq!(anchor_dir(&[inline]), None);
        assert_eq!(anchor_dir(&[]), None);
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "heddle-config-layer-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn includes_come_before_the_entry_that_names_them() {
        let root = scratch("order");
        write(
            &root.join("first.yml"),
            "- insert:\n    - id: first\n      name: ./first\n",
        );
        write(
            &root.join("base.yml"),
            "- include: ./first.yml\n- insert:\n    - id: base\n      name: ./base\n",
        );
        let layers = read_layer(&root.join("base.yml"), &Env::default()).unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(
            layers[0].insert[0].get("id").and_then(LayerValue::as_str),
            Some("first"),
            "the included file's layers come first"
        );
        assert_eq!(
            layers[1].insert[0].get("id").and_then(LayerValue::as_str),
            Some("base")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_include_may_be_a_list_and_paths_are_relative_to_the_naming_file() {
        let root = scratch("list");
        write(
            &root.join("sub/a.yml"),
            "- insert:\n    - id: a\n      name: ./a\n",
        );
        write(
            &root.join("sub/b.yml"),
            "- insert:\n    - id: b\n      name: ./b\n",
        );
        write(
            &root.join("sub/main.yml"),
            "- include:\n    - ./a.yml\n    - ./b.yml\n",
        );
        let layers = read_layer(&root.join("sub/main.yml"), &Env::default()).unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(
            layers[0].insert[0].get("id").and_then(LayerValue::as_str),
            Some("a")
        );
        assert_eq!(
            layers[1].insert[0].get("id").and_then(LayerValue::as_str),
            Some("b")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_cycle_is_refused_by_path_and_names_every_file() {
        let root = scratch("cycle");
        write(&root.join("a.yml"), "- include: ./b.yml\n");
        write(&root.join("b.yml"), "- include: ./a.yml\n");
        let error = read_layer(&root.join("a.yml"), &Env::default()).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "include cycle: {} -> {} -> {}",
                root.join("a.yml").display(),
                root.join("b.yml").display(),
                root.join("a.yml").display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tags_are_kept_as_markers_for_composition_to_resolve() {
        let root = scratch("tags");
        write(
            &root.join("p.yml"),
            "- insert:\n    - id: alpha\n      name: ./alpha\n      config:\n        count: !env COUNT\n        label: ${PREFIX}/v1\n        other: !include ./side.yml\n",
        );
        let layers = read_layer(&root.join("p.yml"), &Env::default()).unwrap();
        let config = layers[0].insert[0].get("config").unwrap();
        assert_eq!(config.get("count"), Some(&LayerValue::Env("COUNT".into())));
        assert_eq!(
            config.get("label"),
            Some(&LayerValue::String("${PREFIX}/v1".into()))
        );
        assert_eq!(
            config.get("other"),
            Some(&LayerValue::Include("./side.yml".into())),
            "an !include inside a value is read as a marker, and refused when resolved"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_top_level_that_is_not_a_list_is_refused() {
        let root = scratch("top");
        write(&root.join("p.yml"), "insert: []\n");
        let error = read_layer(&root.join("p.yml"), &Env::default()).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: expected a top-level array of layers",
                root.join("p.yml").display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_layer_file_whose_document_is_null_reads_as_no_layers() {
        let root = scratch("null-layer");
        for (name, text) in [
            ("null.yml", "null\n"),
            ("tilde.yml", "~\n"),
            ("comment.yml", "# nothing yet\n"),
            ("empty.yml", ""),
        ] {
            write(&root.join(name), text);
            assert!(
                read_layer(&root.join(name), &Env::default())
                    .unwrap_or_else(|error| panic!("{name}: {:?}", error.problems()))
                    .is_empty(),
                "{name} reads as no layers, as the TypeScript build reads it"
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_unknown_key_is_refused() {
        let root = scratch("key");
        write(&root.join("p.yml"), "- insert: []\n  bogus: 1\n");
        let error = read_layer(&root.join("p.yml"), &Env::default()).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: layer 0 has unknown key 'bogus'; expected insert, patch, remove or include",
                root.join("p.yml").display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_field_that_must_be_a_list_is_refused() {
        let root = scratch("lists");
        write(&root.join("p.yml"), "- insert:\n    id: a\n");
        let error = read_layer(&root.join("p.yml"), &Env::default()).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: layer 0: insert must be a list",
                root.join("p.yml").display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_include_that_is_not_a_path_is_refused() {
        let root = scratch("include");
        write(&root.join("p.yml"), "- include: 7\n");
        let error = read_layer(&root.join("p.yml"), &Env::default()).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: include must be a path, not 7",
                root.join("p.yml").display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_empty_file_is_an_empty_layer() {
        let root = scratch("empty");
        write(&root.join("empty.yml"), "");
        write(&root.join("comment.yml"), "# nothing to see here\n");
        assert!(
            read_layer(&root.join("empty.yml"), &Env::default())
                .unwrap()
                .is_empty()
        );
        assert!(
            read_layer(&root.join("comment.yml"), &Env::default())
                .unwrap()
                .is_empty()
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_unknown_tag_is_refused_naming_the_file() {
        let root = scratch("tag");
        write(
            &root.join("p.yml"),
            "- insert:\n    - id: a\n      name: ./a\n      config:\n        x: !bogus 1\n",
        );
        let error = read_layer(&root.join("p.yml"), &Env::default()).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!(
                "{}: unknown tag '!bogus'",
                root.join("p.yml").display()
            )]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_file_is_refused() {
        let root = scratch("missing");
        let error = read_layer(&root.join("nope.yml"), &Env::default()).unwrap_err();
        assert!(error.problems()[0].starts_with("could not read the layer "));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_named_layer_keeps_the_name_and_the_absolute_file() {
        let root = scratch("named");
        write(&root.join("p.yml"), "- insert: []\n");
        let named =
            NamedLayer::read("dev/heddle.patch.yml", &root.join("p.yml"), &Env::default()).unwrap();
        assert_eq!(named.layer, "dev/heddle.patch.yml");
        assert_eq!(
            named.file,
            root.join("p.yml").to_string_lossy(),
            "the file is absolute, as provenance and problems report it"
        );
        assert_eq!(named.entries.len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
