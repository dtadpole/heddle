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

use serde_json::Value;

use crate::env::Env;
use crate::error::ConfigError;
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
        let _ = (layer.into(), file, env);
        todo!("heddle-config: NamedLayer::read")
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
    let _ = (file, env);
    todo!("heddle-config: read_layer")
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
}
