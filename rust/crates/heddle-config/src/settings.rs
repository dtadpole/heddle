//! Settings: the active profile's patch layer as a writable surface, the way DSH's `dsh-settings` over
//! `dsh-config-editor` offers it.
//!
//! **What DSH does** (its package READMEs and type declarations): forms identify each plugin by its
//! profile entry id; a write persists into the active profile's patch, validates the complete candidate
//! before touching disk, and replaces the file atomically, preserving comments outside the replaced
//! values; invalid values and higher-layer overrides leave the file unchanged; home patches and
//! command-line overlays are read for precedence but are never written; a stale write (one carrying a
//! revision older than the entry's) is refused with `settings-conflict`, every other refusal is
//! `settings-rejected`; secrets cross only as presence markers; and a field reset restores the value
//! beneath the profile override. The three writes are `update` (merge fields), `replace` (reset every
//! field, then set the supplied ones) and `mutate` (path-addressed `set` and `unset`).
//!
//! **How heddle does it.**
//!
//! - **The target** ([`settings_target`]) is the active profile's `heddle.patch.yml`: with `--profile`,
//!   the profile's own (created by the first write); otherwise the project patch beside the base layer,
//!   when the run applies it. A run with a `--patch` overlay and no profile applies no project patch,
//!   so nothing is writable — DSH's overlays are never write targets either.
//! - **A managed block.** Neither YAML library the builds use keeps comments, so the writer owns one
//!   region at the end of the target, between [`SETTINGS_BEGIN`] and [`SETTINGS_END`], holding one
//!   `patch` op per entry. Everything outside it is left byte for byte.
//! - **A complete config.** A heddle patch replaces each field it names, so a restated `config` is the
//!   whole config ([`crate::compose()`]). The block therefore restates the entry's complete raw config
//!   with the edits applied — DSH's own documented limitation ("a complete config override … pins
//!   their current raw values at the profile layer"). The raw config is the `config` of the last op that
//!   names the row, so an `${ENV}` or `!env` value stays a reference and is never resolved into the file.
//! - **The base** an `unset` restores is the composition without the managed block. When an entry's
//!   config comes back to its base, its op leaves the block, and an empty block leaves the file.
//! - **Secrets** are values written as environment references and fields named like a credential
//!   ([`is_secret_key`]): they are redacted to `{ path, set }`, kept raw on every write, and a write that
//!   names one is refused — a credential belongs in the environment or the machine file, never in a
//!   profile.
//! - **Revisions** count changes to the raw sections of the target that name an entry, per process,
//!   from 1 ([`SettingsRevisions`]); the file is re-read on every describe and write, so an edit made by
//!   hand bumps the revision too.
//! - **`applies`** is `"restart"`: the written value is what the next boot composes. DSH applies
//!   immediately; heddle's live reload is separate work.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::compose::{ComposedRow, compose};
use crate::env::Env;
use crate::error::ConfigError;
use crate::layer::{NamedLayer, anchor_dir};
use crate::profile::{LayerOptions, PROJECT_PATCH, absolute, resolve_profile};
use crate::references::{references_in, resolve_env};
use crate::validate::{ComponentCatalog, SchemaLookup, validate_rows};
use crate::value::LayerValue;

/// The line that opens the block the settings writer owns.
pub const SETTINGS_BEGIN: &str = "# >>> heddle settings";
/// The line that closes it.
pub const SETTINGS_END: &str = "# <<< heddle settings";
/// What the opening line says after [`SETTINGS_BEGIN`].
const BEGIN_NOTE: &str =
    " (written by the settings API; a value may be edited here, keep both marker lines)";

/// The file settings write and where it sits in the boot's layers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsTarget {
    /// The active profile's `heddle.patch.yml`, absolute; it need not exist yet.
    pub path: PathBuf,
    /// The layer name provenance reports for it (`dev/heddle.patch.yml`, or the absolute path).
    pub label: String,
    /// Its index in the boot's layer list, or the index it takes when the first write creates it.
    pub index: usize,
}

/// The file a settings write lands in for a run booted with `options` from `layers`, or `None` when the
/// run has no profile patch: no profile and no base, or a base with `--patch` overlays (which suppress
/// the project patch, so nothing of the profile's would be written).
pub fn settings_target(
    options: &LayerOptions,
    layers: &[NamedLayer],
    env: &Env,
) -> Option<SettingsTarget> {
    let (path, label, default_index) = if let Some(profile) = &options.profile {
        let profile = resolve_profile(profile, env).ok()?;
        let path = profile.dir.join(PROJECT_PATCH);
        let own = layers
            .iter()
            .take_while(|layer| Path::new(&layer.file).starts_with(&profile.dir))
            .count();
        (path, format!("{}/{PROJECT_PATCH}", profile.name), own)
    } else if let Some(base) = &options.base {
        if !options.include_project_patch {
            return None;
        }
        let base = absolute(base, env);
        let path = base.parent()?.join(PROJECT_PATCH);
        let label = path.to_string_lossy().into_owned();
        (path, label, 1)
    } else {
        return None;
    };
    let file = path.to_string_lossy();
    let (index, label) = match layers.iter().position(|layer| layer.file == file) {
        Some(index) => (index, layers[index].layer.clone()),
        None => (default_index.min(layers.len()), label),
    };
    Some(SettingsTarget { path, label, index })
}

/// One path-addressed edit (`dsh-settings` `SettingsPathOp`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum SettingsPathOp {
    /// Write `value` at `path`, creating intermediate mappings.
    Set {
        /// From the entry's config root; a numeric segment indexes a list.
        path: Vec<String>,
        /// A plain JSON value.
        value: Value,
    },
    /// Restore the value beneath the profile override at `path`, or remove it when there is none; a
    /// list index is removed from its list.
    Unset {
        /// From the entry's config root.
        path: Vec<String>,
    },
}

/// One of DSH's three writes.
#[derive(Clone, Debug, PartialEq)]
pub enum SettingsWrite {
    /// Merge these top-level fields into the entry's config.
    Update(Map<String, Value>),
    /// Restore every field to its base, then set these.
    Replace(Map<String, Value>),
    /// Apply these edits in order.
    Mutate(Vec<SettingsPathOp>),
}

/// Why a write was refused. [`SettingsError::code`] is DSH's wire code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettingsError {
    /// The entry changed since the caller read it.
    Conflict {
        /// The revision the write carried.
        expected: u64,
        /// The revision the entry stands at.
        actual: u64,
    },
    /// Any other refusal, as one sentence; the file is unchanged.
    Rejected(String),
}

impl SettingsError {
    /// `settings-conflict` or `settings-rejected`.
    pub fn code(&self) -> &'static str {
        match self {
            SettingsError::Conflict { .. } => "settings-conflict",
            SettingsError::Rejected(_) => "settings-rejected",
        }
    }

    /// The sentence a caller shows.
    pub fn message(&self) -> String {
        match self {
            SettingsError::Conflict { expected, actual } => format!(
                "the entry changed since it was read (revision {actual}, the write expected {expected}); read it again"
            ),
            SettingsError::Rejected(message) => message.clone(),
        }
    }
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// A secret slot: where it is, and whether it holds a value. The value never crosses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SecretSlot {
    /// From the entry's config root.
    pub path: Vec<String>,
    /// Whether it currently resolves to a value.
    pub set: bool,
}

/// One profile entry's form (`dsh-settings` `SettingsNamespaceView`, plus `component`, `editable` and
/// `reason`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsNamespace {
    /// The entry's `id`.
    pub ns: String,
    /// What the row starts (its `name`).
    pub component: String,
    /// Whether a client may build a page from the schema.
    pub auto_generate: bool,
    /// The component's configuration schema, `null` when it declares none.
    pub schema: Value,
    /// The resolved config, secrets removed.
    pub value: Value,
    /// The config beneath the settings block, secrets removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Value>,
    /// The fields the settings block holds that differ from the base, secrets removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<Value>,
    /// When a written value takes effect: `restart`.
    pub applies: String,
    /// Every secret slot.
    pub secrets: Vec<SecretSlot>,
    /// Send it back as `expectedRevision`.
    pub revision: u64,
    /// Whether a write may name this entry.
    pub editable: bool,
    /// Why not, when it may not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Every profile entry, with the facts a page renders around them (`SettingsDescribeValue`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// Whether the run has a profile patch to write.
    pub writable: bool,
    /// Whether that file exists now. Its path is not sent.
    pub has_document: bool,
    /// One per addressed row.
    pub namespaces: Vec<SettingsNamespace>,
}

/// Per-entry revisions for one process: 1 the first time an entry is read, one more each time the raw
/// sections of the target naming it change.
#[derive(Debug, Default)]
pub struct SettingsRevisions {
    seen: Mutex<BTreeMap<String, (u64, String)>>,
}

impl SettingsRevisions {
    fn revision(&self, ns: &str, digest: &str) -> u64 {
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match seen.get_mut(ns) {
            Some((revision, known)) => {
                if known != digest {
                    *revision += 1;
                    *known = digest.to_string();
                }
                *revision
            }
            None => {
                seen.insert(ns.to_string(), (1, digest.to_string()));
                1
            }
        }
    }
}

/// A write that passed every check, ready for [`commit_settings_write`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedWrite {
    /// The target file.
    pub path: PathBuf,
    /// Its complete new contents.
    pub text: String,
    /// The entry written.
    pub ns: String,
}

/// A field name that holds a credential: `apiKey`, `apiToken`, `token`, `secret`, `password`,
/// whatever the case. Such a field is a secret slot even when written literally.
pub fn is_secret_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "apikey" | "apitoken" | "token" | "secret" | "password"
    )
}

/// Every entry's form for a run booted from `layers`, re-reading the target from disk.
pub fn describe_settings(
    layers: &[NamedLayer],
    target: Option<&SettingsTarget>,
    env: &Env,
    catalog: &dyn ComponentCatalog,
    revisions: &SettingsRevisions,
) -> Result<SettingsView, ConfigError> {
    let state = State::read(layers, target, env)?;
    let rows = compose(&state.current, env)?;
    let base_rows = compose(&state.base, env).ok();
    let anchor = anchor_dir(&state.current);
    let mut namespaces = Vec::new();
    for row in &rows {
        let Some(ns) = row.row.id.clone() else {
            continue;
        };
        namespaces.push(state.namespace(
            &ns,
            row,
            base_rows.as_deref(),
            catalog,
            anchor.as_deref(),
            env,
            revisions,
        ));
    }
    Ok(SettingsView {
        writable: target.is_some(),
        has_document: target.is_some_and(|target| target.path.exists()),
        namespaces,
    })
}

/// Check and prepare one write to entry `ns`. Nothing is written; [`commit_settings_write`] does that.
#[allow(clippy::too_many_arguments)]
pub fn plan_settings_write(
    layers: &[NamedLayer],
    target: Option<&SettingsTarget>,
    env: &Env,
    catalog: &dyn ComponentCatalog,
    revisions: &SettingsRevisions,
    ns: &str,
    write: &SettingsWrite,
    expected_revision: Option<u64>,
) -> Result<PlannedWrite, SettingsError> {
    let Some(target) = target else {
        return Err(SettingsError::Rejected(
            "this run has no profile patch to write: start it with --profile, or from a project whose \
             heddle.patch.yml it applies (a --patch overlay is never a write target)"
                .to_string(),
        ));
    };
    let state = State::read(layers, Some(target), env).map_err(rejected)?;
    let rows = compose(&state.current, env).map_err(rejected)?;
    if !rows.iter().any(|row| row.row.id.as_deref() == Some(ns)) {
        return Err(SettingsError::Rejected(format!(
            "no entry '{ns}' in this run's configuration"
        )));
    }
    if let Some(reason) = state.not_editable(ns) {
        return Err(SettingsError::Rejected(reason));
    }
    let actual = revisions.revision(ns, &state.digest(ns));
    if let Some(expected) = expected_revision
        && expected != actual
    {
        return Err(SettingsError::Conflict { expected, actual });
    }

    let current = raw_config(&state.current, ns).unwrap_or(LayerValue::Mapping(Vec::new()));
    let base = raw_config(&state.base, ns).unwrap_or(LayerValue::Mapping(Vec::new()));
    let next = apply_write(&current, &base, write)?;

    let mut managed = state.managed.clone();
    if next == base {
        managed.retain(|(id, _)| id != ns);
    } else if let Some(slot) = managed.iter_mut().find(|(id, _)| id == ns) {
        slot.1 = next;
    } else {
        managed.push((ns.to_string(), next));
    }
    let text = state.render(&managed).map_err(SettingsError::Rejected)?;

    // The complete candidate, composed and validated before anything touches the disk.
    let candidate = state.with_target_text(&text, env).map_err(rejected)?;
    let result = validate_rows(&candidate, env, catalog).map_err(rejected)?;
    if !result.problems.is_empty() {
        return Err(SettingsError::Rejected(result.problems.join("; ")));
    }
    Ok(PlannedWrite {
        path: target.path.clone(),
        text,
        ns: ns.to_string(),
    })
}

/// Replace the target atomically: write a sibling temporary file, then rename it over the target.
pub fn commit_settings_write(planned: &PlannedWrite) -> Result<(), SettingsError> {
    let dir = planned
        .path
        .parent()
        .ok_or_else(|| SettingsError::Rejected("the profile patch has no directory".to_string()))?;
    let temporary = dir.join(format!(".{PROJECT_PATCH}.settings-{}", std::process::id()));
    let failed = |error: std::io::Error| {
        SettingsError::Rejected(format!(
            "could not write {}: {error}",
            planned.path.display()
        ))
    };
    std::fs::write(&temporary, &planned.text).map_err(failed)?;
    if let Ok(metadata) = std::fs::metadata(&planned.path) {
        let _ = std::fs::set_permissions(&temporary, metadata.permissions());
    }
    std::fs::rename(&temporary, &planned.path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        failed(error)
    })
}

fn rejected(error: ConfigError) -> SettingsError {
    SettingsError::Rejected(error.problems().join("; "))
}

/// The layers with the target as it is on disk now, and without its settings block.
struct State {
    target: Option<SettingsTarget>,
    /// The layers as booted, the target as it was then.
    boot: Vec<NamedLayer>,
    /// The target's text outside the block, in two halves around it.
    before: String,
    after: String,
    /// The block's ops, in written order.
    managed: Vec<(String, LayerValue)>,
    /// The boot's layers with the target re-read.
    current: Vec<NamedLayer>,
    /// The same without the block.
    base: Vec<NamedLayer>,
}

impl State {
    fn read(
        layers: &[NamedLayer],
        target: Option<&SettingsTarget>,
        env: &Env,
    ) -> Result<Self, ConfigError> {
        let Some(target) = target else {
            return Ok(Self {
                target: None,
                boot: layers.to_vec(),
                before: String::new(),
                after: String::new(),
                managed: Vec::new(),
                current: layers.to_vec(),
                base: layers.to_vec(),
            });
        };
        let text = match std::fs::read_to_string(&target.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => {
                return Err(ConfigError::one(format!(
                    "could not read {}: {error}",
                    target.path.display()
                )));
            }
        };
        let (before, block, after) = split_block(&text)
            .map_err(|reason| ConfigError::one(format!("{}: {reason}", target.path.display())))?;
        let managed = match block {
            Some(block) => parse_block(block, &target.path, env)?,
            None => Vec::new(),
        };
        let mut state = Self {
            target: Some(target.clone()),
            boot: layers.to_vec(),
            before: before.to_string(),
            after: after.to_string(),
            managed,
            current: Vec::new(),
            base: Vec::new(),
        };
        state.current = state.with_target_text(&text, env)?;
        let outside = format!("{}{}", state.before, state.after);
        state.base = state.with_target_text(&outside, env)?;
        Ok(state)
    }

    /// The boot's layers with the target replaced by `text` (inserted at its index when the boot had
    /// none, left out when `text` holds no layer).
    fn with_target_text(&self, text: &str, env: &Env) -> Result<Vec<NamedLayer>, ConfigError> {
        let Some(target) = &self.target else {
            return Ok(self.current.clone());
        };
        let mut layers: Vec<NamedLayer> = self
            .boot
            .iter()
            .filter(|layer| Path::new(&layer.file) != target.path)
            .cloned()
            .collect();
        let named = NamedLayer::from_text(target.label.clone(), &target.path, text, env)?;
        if !named.entries.is_empty() {
            layers.insert(target.index.min(layers.len()), named);
        }
        Ok(layers)
    }

    /// Why entry `ns` may not be written, if it may not: inserted by a layer after the profile's own,
    /// or restated or removed by one.
    fn not_editable(&self, ns: &str) -> Option<String> {
        let target = self.target.as_ref()?;
        // The first layer that is not the profile's own: after the target when it is in the tree, else
        // the target's index (where the first write would put it).
        let overlays_from = match self
            .current
            .iter()
            .position(|layer| Path::new(&layer.file) == target.path)
        {
            Some(position) => position + 1,
            None => target.index.min(self.current.len()),
        };
        let mut inserted_at = None;
        for (position, layer) in self.current.iter().enumerate() {
            for entry in &layer.entries {
                if entry.insert.iter().any(|item| id_of(item) == Some(ns)) {
                    inserted_at = Some(position);
                }
            }
        }
        match inserted_at {
            Some(position) if position >= overlays_from => {
                return Some(format!(
                    "entry '{ns}' is inserted by {}, which is not the profile's own layer",
                    self.current[position].layer
                ));
            }
            None => return Some(format!("entry '{ns}' is not inserted by any layer")),
            _ => {}
        }
        for layer in self.current.iter().skip(overlays_from) {
            for entry in &layer.entries {
                let restated = entry
                    .insert
                    .iter()
                    .chain(entry.patch.iter())
                    .any(|item| id_of(item) == Some(ns) && item.get("config").is_some());
                let removed = entry.remove.iter().any(|item| item.as_str() == Some(ns));
                if restated || removed {
                    return Some(format!(
                        "entry '{ns}' is {} by {}, which takes precedence over the profile patch",
                        if removed { "removed" } else { "restated" },
                        layer.layer
                    ));
                }
            }
        }
        None
    }

    /// The raw sections of the target that name `ns`, as text: what a revision counts.
    fn digest(&self, ns: &str) -> String {
        let Some(target) = &self.target else {
            return String::new();
        };
        let mut digest = String::new();
        for layer in self
            .current
            .iter()
            .filter(|layer| Path::new(&layer.file) == target.path)
        {
            for entry in &layer.entries {
                for item in entry.insert.iter().chain(entry.patch.iter()) {
                    if id_of(item) == Some(ns) {
                        digest.push_str(&flow(item).unwrap_or_default());
                        digest.push('\n');
                    }
                }
                for item in &entry.remove {
                    if item.as_str() == Some(ns) {
                        digest.push_str("remove\n");
                    }
                }
            }
        }
        digest
    }

    #[allow(clippy::too_many_arguments)]
    fn namespace(
        &self,
        ns: &str,
        row: &ComposedRow,
        base_rows: Option<&[ComposedRow]>,
        catalog: &dyn ComponentCatalog,
        anchor: Option<&Path>,
        env: &Env,
        revisions: &SettingsRevisions,
    ) -> SettingsNamespace {
        let raw = raw_config(&self.current, ns);
        let secrets = raw
            .as_ref()
            .map(|raw| secret_slots(raw, env))
            .unwrap_or_default();
        let redact = |value: Value| redact(value, &secrets);
        let value = redact(
            row.row
                .config
                .clone()
                .unwrap_or_else(|| Value::Object(Map::new())),
        );
        let base = base_rows
            .and_then(|rows| rows.iter().find(|base| base.row.id.as_deref() == Some(ns)))
            .map(|base| {
                redact(
                    base.row
                        .config
                        .clone()
                        .unwrap_or_else(|| Value::Object(Map::new())),
                )
            });
        let user = self
            .managed
            .iter()
            .find(|(id, _)| id == ns)
            .map(|(_, managed)| {
                let below = raw_config(&self.base, ns);
                let mut fields = Map::new();
                if let LayerValue::Mapping(entries) = managed {
                    for (key, value) in entries {
                        let differs =
                            below.as_ref().and_then(|below| below.get(key)) != Some(value);
                        if differs && let Ok(resolved) = resolve_env(value, "settings", env) {
                            fields.insert(key.clone(), resolved);
                        }
                    }
                }
                redact(Value::Object(fields))
            });
        let schema = match catalog.lookup(&row.row, anchor) {
            SchemaLookup::Schema(schema) => serde_json::to_value(*schema).unwrap_or(Value::Null),
            _ => Value::Null,
        };
        let reason = if self.target.is_none() {
            Some("this run has no profile patch to write".to_string())
        } else {
            self.not_editable(ns)
        };
        SettingsNamespace {
            ns: ns.to_string(),
            component: row.row.name.clone(),
            auto_generate: true,
            schema,
            value,
            base,
            user,
            applies: "restart".to_string(),
            secrets,
            revision: revisions.revision(ns, &self.digest(ns)),
            editable: reason.is_none(),
            reason,
        }
    }

    /// The target's text with `managed` as its block (no block when it is empty).
    fn render(&self, managed: &[(String, LayerValue)]) -> Result<String, String> {
        let mut text = self.before.clone();
        if !managed.is_empty() {
            if !outside_is_block_list(&format!("{}{}", self.before, self.after)) {
                return Err(
                    "the profile patch is not a block list of layers, so the settings block cannot be \
                     appended; write the entry by hand"
                        .to_string(),
                );
            }
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&format!("{SETTINGS_BEGIN}{BEGIN_NOTE}\n- patch:\n"));
            for (id, config) in managed {
                text.push_str(&format!(
                    "    - id: {}\n      config: {}\n",
                    serde_json::to_string(id).unwrap_or_default(),
                    flow(config)?
                ));
            }
            text.push_str(SETTINGS_END);
            text.push('\n');
        }
        text.push_str(&self.after);
        Ok(text)
    }
}

/// `(before, block, after)` around the managed block; the marker lines belong to neither half.
fn split_block(text: &str) -> Result<(&str, Option<&str>, &str), String> {
    let Some(begin) = line_start(text, SETTINGS_BEGIN, 0) else {
        return Ok((text, None, ""));
    };
    let body_start = text[begin..]
        .find('\n')
        .map(|offset| begin + offset + 1)
        .unwrap_or(text.len());
    let Some(end) = line_start(text, SETTINGS_END, body_start) else {
        return Err("the settings block has no end marker".to_string());
    };
    let after_start = text[end..]
        .find('\n')
        .map(|offset| end + offset + 1)
        .unwrap_or(text.len());
    Ok((
        &text[..begin],
        Some(&text[body_start..end]),
        &text[after_start..],
    ))
}

/// The byte offset of the first line at or after `from` that starts with `marker`.
fn line_start(text: &str, marker: &str, from: usize) -> Option<usize> {
    let mut offset = from;
    for line in text[from..].split_inclusive('\n') {
        if line.starts_with(marker) {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

/// The block's `patch` ops, by id, in written order.
fn parse_block(
    block: &str,
    path: &Path,
    env: &Env,
) -> Result<Vec<(String, LayerValue)>, ConfigError> {
    let layer = NamedLayer::from_text("settings block", path, block, env)?;
    let mut managed: Vec<(String, LayerValue)> = Vec::new();
    for entry in &layer.entries {
        for item in &entry.patch {
            if let (Some(id), Some(config)) = (id_of(item), item.get("config")) {
                managed.retain(|(known, _)| known != id);
                managed.push((id.to_string(), config.clone()));
            }
        }
    }
    Ok(managed)
}

/// Whether the text outside the block can take an appended `- patch:` entry: empty of anything but
/// comments, or a block sequence.
fn outside_is_block_list(text: &str) -> bool {
    text.lines()
        .map(str::trim_start)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .is_none_or(|line| line.starts_with('-'))
}

fn id_of(item: &LayerValue) -> Option<&str> {
    item.get("id").and_then(LayerValue::as_str)
}

/// The raw `config` row `ns` composes to: that of the last insert or patch naming it with one.
fn raw_config(layers: &[NamedLayer], ns: &str) -> Option<LayerValue> {
    let mut config = None;
    for layer in layers {
        for entry in &layer.entries {
            for item in &entry.insert {
                if id_of(item) == Some(ns) {
                    config = Some(item.get("config").cloned().unwrap_or(LayerValue::Null));
                }
            }
            for item in &entry.patch {
                if id_of(item) == Some(ns)
                    && let Some(value) = item.get("config")
                {
                    config = Some(value.clone());
                }
            }
        }
    }
    match config {
        Some(LayerValue::Null) | None => None,
        other => other,
    }
}

/// `value` written as one line of YAML flow: JSON, with `!env NAME` for an environment value.
fn flow(value: &LayerValue) -> Result<String, String> {
    Ok(match value {
        LayerValue::Null => "null".to_string(),
        LayerValue::Bool(flag) => flag.to_string(),
        LayerValue::Number(number) => number.to_string(),
        LayerValue::String(text) => serde_json::to_string(text).unwrap_or_default(),
        LayerValue::Sequence(items) => format!(
            "[{}]",
            items
                .iter()
                .map(flow)
                .collect::<Result<Vec<_>, _>>()?
                .join(", ")
        ),
        LayerValue::Mapping(entries) => format!(
            "{{{}}}",
            entries
                .iter()
                .map(|(key, value)| Ok(format!(
                    "{}: {}",
                    serde_json::to_string(key).unwrap_or_default(),
                    flow(value)?
                )))
                .collect::<Result<Vec<_>, String>>()?
                .join(", ")
        ),
        LayerValue::Env(name) => format!("!env {name}"),
        LayerValue::Include(path) => {
            return Err(format!(
                "a config value written as !include {path} cannot be restated by the settings block"
            ));
        }
    })
}

/// Every secret slot in a raw config: environment values, and credential-named fields.
fn secret_slots(raw: &LayerValue, env: &Env) -> Vec<SecretSlot> {
    let mut slots = Vec::new();
    walk_secrets(raw, &mut Vec::new(), env, &mut slots);
    slots
}

fn walk_secrets(
    value: &LayerValue,
    path: &mut Vec<String>,
    env: &Env,
    slots: &mut Vec<SecretSlot>,
) {
    let resolves = |names: &[String]| names.iter().all(|name| env.get(name).is_some());
    match value {
        LayerValue::Env(name) => slots.push(SecretSlot {
            path: path.clone(),
            set: resolves(std::slice::from_ref(name)),
        }),
        LayerValue::String(text) if !references_in(text).is_empty() => slots.push(SecretSlot {
            path: path.clone(),
            set: resolves(&references_in(text)),
        }),
        LayerValue::Mapping(entries) => {
            for (key, child) in entries {
                path.push(key.clone());
                if is_secret_key(key) {
                    slots.push(SecretSlot {
                        path: path.clone(),
                        set: !matches!(child, LayerValue::Null),
                    });
                } else {
                    walk_secrets(child, path, env, slots);
                }
                path.pop();
            }
        }
        LayerValue::Sequence(items) => {
            for (index, child) in items.iter().enumerate() {
                path.push(index.to_string());
                walk_secrets(child, path, env, slots);
                path.pop();
            }
        }
        _ => {}
    }
}

/// `value` with every secret slot removed.
fn redact(mut value: Value, secrets: &[SecretSlot]) -> Value {
    for slot in secrets {
        remove_path(&mut value, &slot.path);
    }
    value
}

fn remove_path(value: &mut Value, path: &[String]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut cursor = value;
    for segment in parents {
        cursor = match cursor {
            Value::Object(map) => match map.get_mut(segment) {
                Some(next) => next,
                None => return,
            },
            Value::Array(items) => {
                match segment.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                    Some(next) => next,
                    None => return,
                }
            }
            _ => return,
        };
    }
    match cursor {
        Value::Object(map) => {
            map.remove(last);
        }
        Value::Array(items) => {
            if let Ok(index) = last.parse::<usize>()
                && index < items.len()
            {
                items[index] = Value::Null;
            }
        }
        _ => {}
    }
}

/// The raw config after `write`, from `current` (what the entry composes to) and `base` (beneath the
/// block). Refuses a write that names a secret or carries an environment reference.
fn apply_write(
    current: &LayerValue,
    base: &LayerValue,
    write: &SettingsWrite,
) -> Result<LayerValue, SettingsError> {
    let secrets = secret_paths(current);
    let check = |path: &[String], value: Option<&Value>| -> Result<(), SettingsError> {
        if path.is_empty() {
            return Err(SettingsError::Rejected(
                "a settings write names a field, not the whole config".to_string(),
            ));
        }
        if path.iter().any(|segment| is_secret_key(segment))
            || secrets
                .iter()
                .any(|secret| path.starts_with(secret) || secret.starts_with(path))
        {
            return Err(SettingsError::Rejected(format!(
                "'{}' is a secret: credentials come from the environment or the machine file, not the profile",
                path.join(".")
            )));
        }
        if value.is_some_and(holds_reference) {
            return Err(SettingsError::Rejected(format!(
                "the value for '{}' holds an environment reference; write the literal value",
                path.join(".")
            )));
        }
        Ok(())
    };
    let mut next = match current {
        LayerValue::Mapping(_) => current.clone(),
        _ => LayerValue::Mapping(Vec::new()),
    };
    match write {
        SettingsWrite::Update(fields) => {
            for (key, value) in fields {
                let path = vec![key.clone()];
                check(&path, Some(value))?;
                set_path(&mut next, &path, LayerValue::from(value.clone()))?;
            }
        }
        SettingsWrite::Replace(fields) => {
            let mut reset = match base {
                LayerValue::Mapping(_) => base.clone(),
                _ => LayerValue::Mapping(Vec::new()),
            };
            // Secrets are not the caller's to reset: they keep their current raw values.
            for secret in &secrets {
                if let Some(value) = get_path(current, secret) {
                    set_path(&mut reset, secret, value.clone())?;
                }
            }
            next = reset;
            for (key, value) in fields {
                let path = vec![key.clone()];
                check(&path, Some(value))?;
                set_path(&mut next, &path, LayerValue::from(value.clone()))?;
            }
        }
        SettingsWrite::Mutate(ops) => {
            for op in ops {
                match op {
                    SettingsPathOp::Set { path, value } => {
                        check(path, Some(value))?;
                        set_path(&mut next, path, LayerValue::from(value.clone()))?;
                    }
                    SettingsPathOp::Unset { path } => {
                        check(path, None)?;
                        match get_path(base, path) {
                            Some(beneath) => set_path(&mut next, path, beneath.clone())?,
                            None => unset_path(&mut next, path),
                        }
                    }
                }
            }
        }
    }
    Ok(next)
}

fn secret_paths(raw: &LayerValue) -> Vec<Vec<String>> {
    secret_slots(raw, &Env::default())
        .into_iter()
        .map(|slot| slot.path)
        .collect()
}

fn holds_reference(value: &Value) -> bool {
    match value {
        Value::String(text) => !references_in(text).is_empty(),
        Value::Array(items) => items.iter().any(holds_reference),
        Value::Object(map) => map.values().any(holds_reference),
        _ => false,
    }
}

fn get_path<'a>(value: &'a LayerValue, path: &[String]) -> Option<&'a LayerValue> {
    let mut cursor = value;
    for segment in path {
        cursor = match cursor {
            LayerValue::Mapping(_) => cursor.get(segment)?,
            LayerValue::Sequence(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cursor)
}

fn set_path(value: &mut LayerValue, path: &[String], new: LayerValue) -> Result<(), SettingsError> {
    let Some((first, rest)) = path.split_first() else {
        *value = new;
        return Ok(());
    };
    match value {
        LayerValue::Mapping(entries) => {
            let position = match entries.iter().position(|(key, _)| key == first) {
                Some(position) => position,
                None => {
                    let empty = if rest.is_empty() {
                        LayerValue::Null
                    } else {
                        LayerValue::Mapping(Vec::new())
                    };
                    entries.push((first.clone(), empty));
                    entries.len() - 1
                }
            };
            set_path(&mut entries[position].1, rest, new)
        }
        LayerValue::Sequence(items) => {
            let index = first
                .parse::<usize>()
                .map_err(|_| SettingsError::Rejected(format!("'{first}' does not index a list")))?;
            if index < items.len() {
                set_path(&mut items[index], rest, new)
            } else if index == items.len() {
                items.push(LayerValue::Null);
                set_path(&mut items[index], rest, new)
            } else {
                Err(SettingsError::Rejected(format!(
                    "index {index} is past the end of a list of {}",
                    items.len()
                )))
            }
        }
        other => {
            *other = LayerValue::Mapping(Vec::new());
            set_path(other, path, new)
        }
    }
}

fn unset_path(value: &mut LayerValue, path: &[String]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut cursor = value;
    for segment in parents {
        cursor = match cursor {
            LayerValue::Mapping(entries) => {
                match entries.iter_mut().find(|(key, _)| key == segment) {
                    Some((_, next)) => next,
                    None => return,
                }
            }
            LayerValue::Sequence(items) => {
                match segment.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                    Some(next) => next,
                    None => return,
                }
            }
            _ => return,
        };
    }
    match cursor {
        LayerValue::Mapping(entries) => entries.retain(|(key, _)| key != last),
        LayerValue::Sequence(items) => {
            if let Ok(index) = last.parse::<usize>()
                && index < items.len()
            {
                items.remove(index);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Schema, StaticCatalog, default_layers};
    use serde_json::json;

    const PROFILE: &str = "# the dev profile, written by hand\n- insert:\n    - id: tools\n      name: tools\n      config: {bashTimeoutMs: 30000, label: plain}\n    - id: keys\n      name: keys\n      config: {token: \"${D1_TOKEN}\", label: shown}\n";

    struct Fixture {
        root: PathBuf,
        env: Env,
        catalog: StaticCatalog,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "heddle-config-settings-{}-{label}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            let profile = root.join("home/profiles/dev");
            std::fs::create_dir_all(&profile).unwrap();
            std::fs::write(profile.join("cordis.yml"), PROFILE).unwrap();
            let env = Env::default()
                .with("HEDDLE_HOME", root.join("home").to_string_lossy())
                .with("HOME", root.to_string_lossy())
                .with("D1_TOKEN", "secret-value");
            let tools = Schema::from_json(json!({
                "type": "object",
                "properties": { "bashTimeoutMs": { "type": "number" }, "label": { "type": "string" } },
                "additionalProperties": false
            }))
            .unwrap();
            let keys = Schema::from_json(json!({ "type": "object" })).unwrap();
            let catalog = StaticCatalog::new()
                .with("tools", Some(tools))
                .with("keys", Some(keys));
            Self { root, env, catalog }
        }

        fn options(&self, patches: Vec<PathBuf>) -> LayerOptions {
            LayerOptions {
                profile: Some("dev".to_string()),
                base: None,
                patches,
                include_project_patch: false,
            }
        }

        fn patch_file(&self) -> PathBuf {
            self.root.join("home/profiles/dev/heddle.patch.yml")
        }

        fn layers(&self, options: &LayerOptions) -> Vec<NamedLayer> {
            default_layers(options, &self.env).unwrap()
        }

        fn view(&self, options: &LayerOptions, revisions: &SettingsRevisions) -> SettingsView {
            let layers = self.layers(options);
            let target = settings_target(options, &layers, &self.env);
            describe_settings(
                &layers,
                target.as_ref(),
                &self.env,
                &self.catalog,
                revisions,
            )
            .unwrap()
        }

        fn write(
            &self,
            options: &LayerOptions,
            revisions: &SettingsRevisions,
            ns: &str,
            write: SettingsWrite,
            expected: Option<u64>,
        ) -> Result<(), SettingsError> {
            let layers = self.layers(options);
            let target = settings_target(options, &layers, &self.env);
            let planned = plan_settings_write(
                &layers,
                target.as_ref(),
                &self.env,
                &self.catalog,
                revisions,
                ns,
                &write,
                expected,
            )?;
            commit_settings_write(&planned)
        }

        /// What a fresh boot composes `ns`'s config to.
        fn composed(&self, options: &LayerOptions, ns: &str) -> Value {
            let rows = compose(&self.layers(options), &self.env).unwrap();
            let row = rows
                .iter()
                .find(|row| row.row.id.as_deref() == Some(ns))
                .unwrap();
            row.row.config.clone().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn update(fields: Value) -> SettingsWrite {
        SettingsWrite::Update(fields.as_object().unwrap().clone())
    }

    fn entry<'a>(view: &'a SettingsView, ns: &str) -> &'a SettingsNamespace {
        view.namespaces.iter().find(|entry| entry.ns == ns).unwrap()
    }

    #[test]
    fn the_target_is_the_active_profiles_patch_and_an_overlay_is_never_one() {
        let fixture = Fixture::new("target");
        let options = fixture.options(Vec::new());
        let layers = fixture.layers(&options);
        let target = settings_target(&options, &layers, &fixture.env).unwrap();
        assert_eq!(target.path, fixture.patch_file());
        assert_eq!(target.label, "dev/heddle.patch.yml");
        assert_eq!(target.index, 1, "after the profile's cordis.yml");

        let project = fixture.root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("cordis.yml"), "[]\n").unwrap();
        let base = LayerOptions {
            profile: None,
            base: Some(project.join("cordis.yml")),
            patches: Vec::new(),
            include_project_patch: true,
        };
        let layers = default_layers(&base, &fixture.env).unwrap();
        let target = settings_target(&base, &layers, &fixture.env).unwrap();
        assert_eq!(target.path, project.join("heddle.patch.yml"));

        let overlay = LayerOptions {
            include_project_patch: false,
            patches: vec![project.join("cordis.yml")],
            ..base
        };
        let layers = default_layers(&overlay, &fixture.env).unwrap();
        assert_eq!(settings_target(&overlay, &layers, &fixture.env), None);
    }

    #[test]
    fn describe_lists_each_entry_with_secrets_reduced_to_presence() {
        let fixture = Fixture::new("describe");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        let view = fixture.view(&options, &revisions);
        assert!(view.writable);
        assert!(!view.has_document, "the profile patch does not exist yet");
        let tools = entry(&view, "tools");
        assert_eq!(
            tools.value,
            json!({ "bashTimeoutMs": 30000, "label": "plain" })
        );
        assert_eq!(tools.revision, 1);
        assert!(tools.editable);
        assert_eq!(tools.applies, "restart");
        assert_eq!(tools.user, None);
        assert_eq!(
            tools.schema["properties"]["bashTimeoutMs"]["type"],
            "number"
        );
        let keys = entry(&view, "keys");
        assert_eq!(
            keys.value,
            json!({ "label": "shown" }),
            "the token never crosses"
        );
        assert_eq!(
            keys.secrets,
            vec![SecretSlot {
                path: vec!["token".into()],
                set: true
            }]
        );
        let text = serde_json::to_string(&view).unwrap();
        assert!(!text.contains("secret-value"));
    }

    #[test]
    fn an_update_lands_in_the_profile_patch_and_the_next_boot_composes_it() {
        let fixture = Fixture::new("update");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        let handwritten = "# kept as written\n- patch:\n    - id: keys\n      config: {token: \"${D1_TOKEN}\", label: by-hand}\n";
        std::fs::write(fixture.patch_file(), handwritten).unwrap();
        let before = fixture.view(&options, &revisions);
        let revision = entry(&before, "tools").revision;

        fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "bashTimeoutMs": 60000 })),
                Some(revision),
            )
            .unwrap();
        let text = std::fs::read_to_string(fixture.patch_file()).unwrap();
        assert!(
            text.starts_with(handwritten),
            "everything outside the block is kept byte for byte"
        );
        assert!(text.contains(SETTINGS_BEGIN) && text.contains(SETTINGS_END));
        assert!(
            text.contains(r#"config: {"bashTimeoutMs": 60000, "label": "plain"}"#),
            "{text}"
        );
        assert_eq!(
            fixture.composed(&options, "tools"),
            json!({ "bashTimeoutMs": 60000, "label": "plain" })
        );
        let after = fixture.view(&options, &revisions);
        let tools = entry(&after, "tools");
        assert_eq!(tools.revision, revision + 1);
        assert_eq!(tools.user, Some(json!({ "bashTimeoutMs": 60000 })));
        assert_eq!(
            tools.base,
            Some(json!({ "bashTimeoutMs": 30000, "label": "plain" }))
        );
        assert!(after.has_document);
    }

    #[test]
    fn a_stale_write_is_refused_as_a_conflict_and_changes_nothing() {
        let fixture = Fixture::new("stale");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        let read = entry(&fixture.view(&options, &revisions), "tools").revision;
        fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "label": "first" })),
                Some(read),
            )
            .unwrap();
        let written = std::fs::read_to_string(fixture.patch_file()).unwrap();
        let error = fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "label": "second" })),
                Some(read),
            )
            .unwrap_err();
        assert_eq!(
            error,
            SettingsError::Conflict {
                expected: read,
                actual: read + 1
            }
        );
        assert_eq!(error.code(), "settings-conflict");
        assert_eq!(
            std::fs::read_to_string(fixture.patch_file()).unwrap(),
            written
        );
    }

    #[test]
    fn an_invalid_value_is_refused_naming_the_row_and_the_file_is_untouched() {
        let fixture = Fixture::new("invalid");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        let error = fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "bashTimeoutMs": "soon" })),
                None,
            )
            .unwrap_err();
        assert_eq!(error.code(), "settings-rejected");
        assert!(error.message().contains("tools"), "{}", error.message());
        assert!(!fixture.patch_file().exists(), "no file was created");
    }

    #[test]
    fn a_higher_layer_override_refuses_the_write() {
        let fixture = Fixture::new("override");
        let overlay = fixture.root.join("overlay.yml");
        std::fs::write(
            &overlay,
            "- patch:\n    - id: tools\n      config: {bashTimeoutMs: 1000}\n",
        )
        .unwrap();
        let options = fixture.options(vec![overlay.clone()]);
        let revisions = SettingsRevisions::default();
        let tools = entry(&fixture.view(&options, &revisions), "tools").clone();
        assert!(!tools.editable);
        assert!(tools.reason.unwrap().contains("takes precedence"));
        let error = fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "label": "x" })),
                None,
            )
            .unwrap_err();
        assert!(
            error
                .message()
                .contains(&overlay.to_string_lossy().to_string()),
            "{error}"
        );
        assert!(!fixture.patch_file().exists());
    }

    #[test]
    fn unset_restores_the_base_and_an_empty_block_restores_the_file() {
        let fixture = Fixture::new("unset");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        let original = "# my patch\n- patch:\n    - id: keys\n      config: {token: \"${D1_TOKEN}\", label: mine}\n";
        std::fs::write(fixture.patch_file(), original).unwrap();
        fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "bashTimeoutMs": 5 })),
                None,
            )
            .unwrap();
        fixture
            .write(
                &options,
                &revisions,
                "tools",
                SettingsWrite::Mutate(vec![SettingsPathOp::Unset {
                    path: vec!["bashTimeoutMs".into()],
                }]),
                None,
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.patch_file()).unwrap(),
            original
        );
        assert_eq!(fixture.composed(&options, "tools")["bashTimeoutMs"], 30000);
    }

    #[test]
    fn replace_resets_every_field_then_sets_the_given_ones() {
        let fixture = Fixture::new("replace");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "bashTimeoutMs": 5, "label": "x" })),
                None,
            )
            .unwrap();
        fixture
            .write(
                &options,
                &revisions,
                "tools",
                SettingsWrite::Replace(json!({ "label": "y" }).as_object().unwrap().clone()),
                None,
            )
            .unwrap();
        assert_eq!(
            fixture.composed(&options, "tools"),
            json!({ "bashTimeoutMs": 30000, "label": "y" })
        );
    }

    #[test]
    fn secrets_and_references_are_never_written_and_existing_ones_stay_raw() {
        let fixture = Fixture::new("secrets");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        let error = fixture
            .write(
                &options,
                &revisions,
                "keys",
                update(json!({ "token": "pasted" })),
                None,
            )
            .unwrap_err();
        assert!(error.message().contains("secret"), "{error}");
        let error = fixture
            .write(
                &options,
                &revisions,
                "keys",
                update(json!({ "label": "${HOME}" })),
                None,
            )
            .unwrap_err();
        assert!(error.message().contains("environment reference"), "{error}");
        fixture
            .write(
                &options,
                &revisions,
                "keys",
                update(json!({ "label": "edited" })),
                None,
            )
            .unwrap();
        let text = std::fs::read_to_string(fixture.patch_file()).unwrap();
        assert!(
            text.contains(r#""token": "${D1_TOKEN}""#),
            "the reference is kept: {text}"
        );
        assert!(!text.contains("secret-value"));
        assert_eq!(fixture.composed(&options, "keys")["token"], "secret-value");
    }

    #[test]
    fn a_hand_edit_moves_the_revision() {
        let fixture = Fixture::new("hand-edit");
        let options = fixture.options(Vec::new());
        let revisions = SettingsRevisions::default();
        let first = entry(&fixture.view(&options, &revisions), "tools").revision;
        std::fs::write(
            fixture.patch_file(),
            "- patch:\n    - id: tools\n      config: {bashTimeoutMs: 7}\n",
        )
        .unwrap();
        let second = entry(&fixture.view(&options, &revisions), "tools").revision;
        assert_eq!(second, first + 1);
        let error = fixture
            .write(
                &options,
                &revisions,
                "tools",
                update(json!({ "label": "x" })),
                Some(first),
            )
            .unwrap_err();
        assert_eq!(error.code(), "settings-conflict");
    }

    #[test]
    fn without_a_target_nothing_is_writable() {
        let fixture = Fixture::new("no-target");
        let base = LayerOptions {
            profile: None,
            base: None,
            patches: vec![fixture.root.join("home/profiles/dev/cordis.yml")],
            include_project_patch: false,
        };
        let layers = default_layers(&base, &fixture.env).unwrap();
        let revisions = SettingsRevisions::default();
        let view =
            describe_settings(&layers, None, &fixture.env, &fixture.catalog, &revisions).unwrap();
        assert!(!view.writable);
        assert!(view.namespaces.iter().all(|entry| !entry.editable));
        let error = plan_settings_write(
            &layers,
            None,
            &fixture.env,
            &fixture.catalog,
            &revisions,
            "tools",
            &update(json!({ "label": "x" })),
            None,
        )
        .unwrap_err();
        assert!(error.message().contains("no profile patch"), "{error}");
    }

    #[test]
    fn an_entry_an_overlay_inserts_is_not_the_profiles_to_edit() {
        let fixture = Fixture::new("overlay-insert");
        let overlay = fixture.root.join("extra.yml");
        std::fs::write(
            &overlay,
            "- insert:\n    - id: extra\n      name: tools\n      config: {label: o}\n",
        )
        .unwrap();
        let options = fixture.options(vec![overlay]);
        let revisions = SettingsRevisions::default();
        let extra = entry(&fixture.view(&options, &revisions), "extra").clone();
        assert!(!extra.editable);
        assert!(
            extra
                .reason
                .unwrap()
                .contains("not the profile's own layer")
        );
    }

    #[test]
    fn the_block_round_trips_environment_markers_and_flow_values() {
        let value = LayerValue::Mapping(vec![
            ("a".into(), LayerValue::Env("D1_TOKEN".into())),
            (
                "b".into(),
                LayerValue::Sequence(vec![
                    LayerValue::from(json!(1)),
                    LayerValue::from(json!("x")),
                ]),
            ),
            (
                "c".into(),
                LayerValue::from(json!({ "d": null, "e": true })),
            ),
        ]);
        let text = format!(
            "- patch:\n    - id: r\n      config: {}\n",
            flow(&value).unwrap()
        );
        let parsed = parse_block(&text, Path::new("/tmp/x.yml"), &Env::default()).unwrap();
        assert_eq!(parsed, vec![("r".to_string(), value)]);
    }
}
