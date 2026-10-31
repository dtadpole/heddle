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
    /// When a written value takes effect: `live` when the server applies a write to the running tree as it lands
    /// ([`SettingsService::with_live`]), `restart` when the next boot does.
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
    /// Set on a write's answer when the file was written but the running tree refused the value; the next boot
    /// applies it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apply_error: Option<String>,
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

/// One run's settings surface: the layers it booted, its target, and the revisions it has handed out.
/// Writes are serialised, as DSH serialises them with other profile changes.
pub struct SettingsService {
    layers: Vec<NamedLayer>,
    target: Option<SettingsTarget>,
    env: Env,
    catalog: Box<dyn ComponentCatalog + Send + Sync>,
    revisions: SettingsRevisions,
    writing: Mutex<()>,
    live: Vec<String>,
    applier: Option<SettingsApplier>,
}

/// Apply entry `ns`'s newly composed, resolved config to the running tree; an error is the running tree's refusal.
pub type SettingsApplier = Box<dyn Fn(&str, &Value) -> Result<(), String> + Send + Sync>;

impl SettingsService {
    /// Open the profile's patch with `opener`, creating it empty first when it is not there yet (an absent patch reads
    /// as empty, so the empty file changes nothing). A run without a profile patch has no document to open.
    ///
    /// # Errors
    ///
    /// [`OpenDocumentError::NoTarget`] without a profile patch, else the creation's or the opener's failure.
    pub fn open_document(&self, opener: &DocumentOpener<'_>) -> Result<(), OpenDocumentError> {
        let Some(target) = self.target.as_ref() else {
            return Err(OpenDocumentError::NoTarget);
        };
        if !target.path.exists() {
            if let Some(parent) = target.path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| OpenDocumentError::Failed(error.to_string()))?;
            }
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target.path)
            {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(OpenDocumentError::Failed(error.to_string())),
            }
        }
        opener(&target.path).map_err(OpenDocumentError::Failed)
    }

    /// The surface for a run booted with `options` and the in-memory `overrides` the flags appended.
    pub fn new(
        options: &LayerOptions,
        overrides: &[NamedLayer],
        env: Env,
        catalog: Box<dyn ComponentCatalog + Send + Sync>,
    ) -> Result<Self, ConfigError> {
        let mut layers = crate::profile::default_layers(options, &env)?;
        layers.extend(overrides.iter().cloned());
        let target = settings_target(options, &layers, &env);
        Ok(Self {
            layers,
            target,
            env,
            catalog,
            revisions: SettingsRevisions::default(),
            writing: Mutex::new(()),
            live: Vec::new(),
            applier: None,
        })
    }

    /// The entries in `live` apply a write to the running tree as it lands, through `apply`, and report
    /// `applies: live`, as DSH's settings do; every other entry stays `restart`. The binary marks the model row,
    /// whose service re-reads its composition on the next request.
    #[must_use]
    pub fn with_live(mut self, live: Vec<String>, apply: SettingsApplier) -> Self {
        self.live = live;
        self.applier = Some(apply);
        self
    }

    /// Every entry's form, the target re-read.
    pub fn describe(&self) -> Result<SettingsView, ConfigError> {
        let mut view = describe_settings(
            &self.layers,
            self.target.as_ref(),
            &self.env,
            self.catalog.as_ref(),
            &self.revisions,
        )?;
        for entry in &mut view.namespaces {
            if self.applier.is_some() && self.live.contains(&entry.ns) {
                entry.applies = "live".to_string();
            }
        }
        Ok(view)
    }

    /// Check, write and re-read entry `ns`; the answer is its new form.
    pub fn write(
        &self,
        ns: &str,
        write: &SettingsWrite,
        expected_revision: Option<u64>,
    ) -> Result<SettingsNamespace, SettingsError> {
        let _serial = self
            .writing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let planned = plan_settings_write(
            &self.layers,
            self.target.as_ref(),
            &self.env,
            self.catalog.as_ref(),
            &self.revisions,
            ns,
            write,
            expected_revision,
        )?;
        commit_settings_write(&planned)?;
        // Applied to the running tree as it lands, for a live entry: its composed, resolved config is what the next
        // boot would hand it. A refusal does not undo the write; the answer says so and the next boot applies it.
        let mut apply_error = None;
        if let Some(apply) = &self.applier
            && self.live.iter().any(|live| live == ns)
        {
            let config = State::read(&self.layers, self.target.as_ref(), &self.env)
                .and_then(|state| compose(&state.current, &self.env))
                .map_err(|error| error.problems().join("; "))
                .map(|rows| {
                    rows.into_iter()
                        .find(|row| row.row.id.as_deref() == Some(ns))
                        .and_then(|row| row.row.config)
                        .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
                });
            if let Err(error) = config.and_then(|config| apply(ns, &config)) {
                apply_error = Some(error);
            }
        }
        let view = self.describe().map_err(rejected)?;
        let mut entry = view
            .namespaces
            .into_iter()
            .find(|entry| entry.ns == ns)
            .ok_or_else(|| {
                SettingsError::Rejected(format!("entry '{ns}' vanished after the write"))
            })?;
        entry.apply_error = apply_error;
        Ok(entry)
    }
}

/// An answer to a settings route: the HTTP status and the JSON body.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingsResponse {
    /// 200, 400, 404, 405, 409 or 422.
    pub status: u16,
    /// The view, the entry, or `{ code, error, … }`.
    pub body: Value,
}

/// Answer `GET /api/settings`, `GET /api/settings/{ns}` and `POST /api/settings/{ns}`; `None` for any
/// other path. A POST body is `{ "update" | "replace": { … } }` or `{ "ops": [ … ] }`, with an optional
/// `expectedRevision` — DSH's `settings.update`, `.replace` and `.mutate`.
pub fn handle_settings_request(
    service: &SettingsService,
    method: &str,
    path: &str,
    body: &[u8],
) -> Option<SettingsResponse> {
    handle_settings_request_with(
        service,
        method,
        path,
        body,
        &SettingsRequestContext::default(),
    )
}

/// Opens a document in the person's text editor; an error is a sentence.
pub type DocumentOpener<'a> = dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync + 'a;

/// What the route knows about a settings request beyond its path (A95): whether it came from a page on this machine,
/// and what opens the configuration file (the platform's opener when `None`).
#[derive(Default)]
pub struct SettingsRequestContext<'a> {
    pub loopback: bool,
    pub opener: Option<&'a DocumentOpener<'a>>,
}

/// Whether a request's `Host` names this machine: a page on another host never gets the native open action (DSH).
pub fn loopback_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    name == "localhost"
        || name == "::1"
        || name
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|address| address.is_loopback())
}

/// What opens a document in the person's text editor (A95, DSH's `settings/openSettingsDocument`): `open -t` on
/// macOS, which bypasses a browser's claim on the file type, the desktop's association elsewhere (`xdg-open`,
/// Windows' `start`). `HEDDLE_OPEN_COMMAND` names another program, given the path as its one argument. It returns
/// once the program has started; what the editor does after that is the person's.
///
/// # Errors
///
/// The program could not be started.
pub fn open_document(env: &Env, path: &std::path::Path) -> Result<(), String> {
    let mut command = match env.non_empty("HEDDLE_OPEN_COMMAND") {
        Some(program) => std::process::Command::new(program),
        None if cfg!(target_os = "macos") => {
            let mut command = std::process::Command::new("open");
            command.arg("-t");
            command
        }
        None if cfg!(windows) => {
            let mut command = std::process::Command::new("cmd");
            // `start` takes its first quoted argument as a window title; an empty argument goes out as "".
            command.args(["/c", "start", ""]);
            command
        }
        None => std::process::Command::new("xdg-open"),
    };
    command
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|mut child| {
            // Reap it when it exits, so a click leaves no zombie behind (developer-ten N3).
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        })
        .map_err(|error| error.to_string())
}

/// [`handle_settings_request`] with the request's [`SettingsRequestContext`], which `POST /api/settings`
/// `{"open": "document"}` needs.
pub fn handle_settings_request_with(
    service: &SettingsService,
    method: &str,
    path: &str,
    body: &[u8],
    context: &SettingsRequestContext<'_>,
) -> Option<SettingsResponse> {
    let path = path.split('?').next().unwrap_or(path);
    let rest = path.strip_prefix("/api/settings")?;
    let ns = match rest {
        "" | "/" => None,
        other => Some(decode_segment(other.strip_prefix('/')?)?),
    };
    let fail = |status: u16, code: &str, error: String| SettingsResponse {
        status,
        body: serde_json::json!({ "code": code, "error": error }),
    };
    let ok = |value: Value| SettingsResponse {
        status: 200,
        body: value,
    };
    Some(match (method, ns) {
        ("GET", None) => match service.describe() {
            Ok(view) => ok(serde_json::to_value(view).unwrap_or(Value::Null)),
            Err(error) => fail(422, "settings-rejected", error.problems().join("; ")),
        },
        ("GET", Some(ns)) => match service.describe() {
            Ok(view) => match view.namespaces.into_iter().find(|entry| entry.ns == ns) {
                Some(entry) => ok(serde_json::to_value(entry).unwrap_or(Value::Null)),
                None => fail(404, "settings-rejected", format!("no entry '{ns}'")),
            },
            Err(error) => fail(422, "settings-rejected", error.problems().join("; ")),
        },
        ("POST", Some(ns)) => {
            let Ok(request @ Value::Object(_)) = serde_json::from_slice::<Value>(body) else {
                return Some(fail(
                    400,
                    "bad-request",
                    "the body must be a JSON object".into(),
                ));
            };
            let expected = match request.get("expectedRevision") {
                None | Some(Value::Null) => None,
                Some(value) => match value.as_u64() {
                    Some(revision) => Some(revision),
                    None => {
                        return Some(fail(
                            400,
                            "bad-request",
                            "expectedRevision must be a whole number".into(),
                        ));
                    }
                },
            };
            let fields = |key: &str| request.get(key).and_then(Value::as_object).cloned();
            let write = match (fields("update"), fields("replace"), request.get("ops")) {
                (Some(patch), None, None) => SettingsWrite::Update(patch),
                (None, Some(section), None) => SettingsWrite::Replace(section),
                (None, None, Some(ops)) => {
                    match serde_json::from_value::<Vec<SettingsPathOp>>(ops.clone()) {
                        Ok(ops) => SettingsWrite::Mutate(ops),
                        Err(error) => {
                            return Some(fail(400, "bad-request", format!("ops: {error}")));
                        }
                    }
                }
                _ => {
                    return Some(fail(
                        400,
                        "bad-request",
                        "send exactly one of update or replace (an object) or ops (a list)".into(),
                    ));
                }
            };
            match service.write(&ns, &write, expected) {
                Ok(entry) => ok(serde_json::to_value(entry).unwrap_or(Value::Null)),
                Err(error @ SettingsError::Conflict { expected, actual }) => SettingsResponse {
                    status: 409,
                    body: serde_json::json!({
                        "code": error.code(),
                        "error": error.message(),
                        "expected": expected,
                        "actual": actual,
                    }),
                },
                Err(error) => fail(422, error.code(), error.message()),
            }
        }
        ("POST", None) => open_document_request(service, body, context),
        _ => fail(
            405,
            "bad-request",
            format!("{method} is not a settings method here"),
        ),
    })
}

/// `POST /api/settings` `{"open": "document"}` (A95): open the profile's patch in the person's text editor, creating
/// it empty when it is not there yet, as DSH's Host materialises an absent document. Pathless: the server resolves
/// the file, so a page never names one. Only for a page on this machine; another host is refused.
fn open_document_request(
    service: &SettingsService,
    body: &[u8],
    context: &SettingsRequestContext<'_>,
) -> SettingsResponse {
    let fail = |status: u16, code: &str, error: String| SettingsResponse {
        status,
        body: serde_json::json!({ "code": code, "error": error }),
    };
    // Exactly {"open": "document"}: the request is pathless, so a body that names anything else is refused.
    let asked = serde_json::from_slice::<Value>(body)
        .ok()
        .is_some_and(|request| {
            request.as_object().is_some_and(|object| object.len() == 1)
                && request.get("open").and_then(Value::as_str) == Some("document")
        });
    if !asked {
        return fail(
            400,
            "bad-request",
            "send {\"open\": \"document\"} to open the configuration file".into(),
        );
    }
    if !context.loopback {
        return fail(
            403,
            "bad-request",
            "the configuration file opens only from a page on this machine".into(),
        );
    }
    let opened = match context.opener {
        Some(opener) => service.open_document(opener),
        None => service.open_document(&|path: &std::path::Path| open_document(&service.env, path)),
    };
    match opened {
        Ok(()) => SettingsResponse {
            status: 200,
            body: serde_json::json!({ "opened": true }),
        },
        Err(OpenDocumentError::NoTarget) => fail(
            409,
            "settings-rejected",
            "this run has no profile patch to open (start it with --profile, or from a project without --patch)"
                .into(),
        ),
        Err(OpenDocumentError::Failed(error)) => fail(
            500,
            "settings-rejected",
            format!("could not open the configuration file: {error}"),
        ),
    }
}

/// Why the configuration file did not open.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenDocumentError {
    /// The run has no profile patch.
    NoTarget,
    /// The file could not be created, or the opener could not start.
    Failed(String),
}

/// A path segment with `%XX` escapes decoded; `None` when an escape is malformed or the result is not
/// UTF-8.
fn decode_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
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
        // DSH's form projection where the catalog has one (every built-in with a Config, #123), else the plain schema.
        let schema = match catalog.form(&row.row, anchor) {
            Some(form) => form,
            None => match catalog.lookup(&row.row, anchor) {
                SchemaLookup::Schema(schema) => {
                    serde_json::to_value(*schema).unwrap_or(Value::Null)
                }
                _ => Value::Null,
            },
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
            apply_error: None,
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

    #[test]
    fn a_live_entry_is_applied_to_the_running_tree_as_it_lands() {
        let fixture = Fixture::new("live");
        let applied: std::sync::Arc<Mutex<Vec<(String, Value)>>> = std::sync::Arc::default();
        let seen = std::sync::Arc::clone(&applied);
        let service = SettingsService::new(
            &fixture.options(Vec::new()),
            &[],
            fixture.env.clone(),
            Box::new(fixture.catalog.clone()),
        )
        .unwrap()
        .with_live(
            vec!["tools".to_string()],
            Box::new(move |ns, config| {
                seen.lock().unwrap().push((ns.to_string(), config.clone()));
                Ok(())
            }),
        );
        let view = service.describe().unwrap();
        let applies = |ns: &str| {
            view.namespaces
                .iter()
                .find(|entry| entry.ns == ns)
                .map(|entry| entry.applies.clone())
        };
        assert_eq!(applies("tools").as_deref(), Some("live"));
        assert_eq!(
            applies("keys").as_deref(),
            Some("restart"),
            "only the entries the server can apply"
        );
        let entry = service
            .write(
                "tools",
                &SettingsWrite::Update(
                    json!({ "bashTimeoutMs": 60000 })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                None,
            )
            .unwrap();
        assert_eq!(entry.apply_error, None);
        assert_eq!(
            applied.lock().unwrap().clone(),
            vec![(
                "tools".to_string(),
                json!({ "bashTimeoutMs": 60000, "label": "plain" })
            )],
            "the composed config, as the next boot would give it"
        );
        service
            .write(
                "keys",
                &SettingsWrite::Update(json!({ "label": "edited" }).as_object().unwrap().clone()),
                None,
            )
            .unwrap();
        assert_eq!(
            applied.lock().unwrap().len(),
            1,
            "a restart entry is not applied"
        );
        std::fs::remove_dir_all(&fixture.root).ok();
    }

    #[test]
    fn a_write_the_running_tree_refuses_is_still_written_and_says_so() {
        let fixture = Fixture::new("live-refused");
        let service = SettingsService::new(
            &fixture.options(Vec::new()),
            &[],
            fixture.env.clone(),
            Box::new(fixture.catalog.clone()),
        )
        .unwrap()
        .with_live(
            vec!["tools".to_string()],
            Box::new(|_, _| Err("the entry could not be re-applied".to_string())),
        );
        let entry = service
            .write(
                "tools",
                &SettingsWrite::Update(
                    json!({ "bashTimeoutMs": 60000 })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                None,
            )
            .unwrap();
        assert_eq!(
            entry.apply_error.as_deref(),
            Some("the entry could not be re-applied")
        );
        let written = std::fs::read_to_string(fixture.patch_file()).unwrap();
        assert!(
            written.contains("\"bashTimeoutMs\": 60000"),
            "the next boot still applies it: {written}"
        );
        std::fs::remove_dir_all(&fixture.root).ok();
    }

    #[test]
    fn the_routes_answer_as_dsh_settings_calls_do() {
        let fixture = Fixture::new("routes");
        let service = SettingsService::new(
            &fixture.options(Vec::new()),
            &[],
            fixture.env.clone(),
            Box::new(fixture.catalog.clone()),
        )
        .unwrap();
        let call = |method: &str, path: &str, body: Value| {
            handle_settings_request(&service, method, path, body.to_string().as_bytes()).unwrap()
        };

        let view = call("GET", "/api/settings", Value::Null);
        assert_eq!(view.status, 200);
        assert_eq!(view.body["writable"], true);
        let revision = view.body["namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["ns"] == "tools")
            .unwrap()["revision"]
            .as_u64()
            .unwrap();

        let written = call(
            "POST",
            "/api/settings/tools",
            json!({ "update": { "label": "routed" }, "expectedRevision": revision }),
        );
        assert_eq!(written.status, 200, "{}", written.body);
        assert_eq!(written.body["value"]["label"], "routed");
        assert_eq!(written.body["revision"], revision + 1);

        let stale = call(
            "POST",
            "/api/settings/tools",
            json!({ "update": { "label": "late" }, "expectedRevision": revision }),
        );
        assert_eq!(stale.status, 409);
        assert_eq!(stale.body["code"], "settings-conflict");
        assert_eq!(stale.body["expected"], revision);
        assert_eq!(stale.body["actual"], revision + 1);

        let invalid = call(
            "POST",
            "/api/settings/tools",
            json!({ "update": { "bashTimeoutMs": [] } }),
        );
        assert_eq!(invalid.status, 422);
        assert_eq!(invalid.body["code"], "settings-rejected");

        let ops = call(
            "POST",
            "/api/settings/tools",
            json!({ "ops": [{ "op": "unset", "path": ["label"] }] }),
        );
        assert_eq!(ops.status, 200, "{}", ops.body);
        assert_eq!(ops.body["value"]["label"], "plain");

        let both = call(
            "POST",
            "/api/settings/tools",
            json!({ "update": {}, "replace": {} }),
        );
        assert_eq!(both.status, 400);
        assert_eq!(both.body["code"], "bad-request");
        let one = call("GET", "/api/settings/keys", Value::Null);
        assert_eq!(one.status, 200);
        assert_eq!(one.body["ns"], "keys");
        assert_eq!(
            call("GET", "/api/settings/nowhere", Value::Null).status,
            404
        );
        assert_eq!(
            call("DELETE", "/api/settings/tools", Value::Null).status,
            405
        );
        assert!(handle_settings_request(&service, "GET", "/api/status", b"").is_none());
    }
    #[test]
    fn the_configuration_file_opens_only_for_a_page_on_this_machine_and_is_created_when_absent() {
        assert!(loopback_host(Some("127.0.0.1:8082")));
        assert!(loopback_host(Some("localhost:3000")));
        assert!(loopback_host(Some("[::1]:80")));
        assert!(!loopback_host(Some("heddle.example.com")));
        assert!(!loopback_host(Some("203.0.113.4:8082")));
        assert!(!loopback_host(None));

        let fixture = Fixture::new("open-document");
        let service = SettingsService::new(
            &fixture.options(Vec::new()),
            &[],
            fixture.env.clone(),
            Box::new(fixture.catalog.clone()),
        )
        .unwrap();
        let patch = service
            .target
            .as_ref()
            .expect("the fixture's profile patch")
            .path
            .clone();
        let _ = std::fs::remove_file(&patch);
        let opened = std::sync::Mutex::new(Vec::new());
        let opener = |path: &std::path::Path| -> Result<(), String> {
            opened.lock().unwrap().push(path.to_path_buf());
            Ok(())
        };
        let ask = |loopback: bool, body: &str| {
            handle_settings_request_with(
                &service,
                "POST",
                "/api/settings",
                body.as_bytes(),
                &SettingsRequestContext {
                    loopback,
                    opener: Some(&opener),
                },
            )
            .unwrap()
        };
        let remote = ask(false, r#"{"open": "document"}"#);
        assert_eq!(remote.status, 403, "{}", remote.body);
        assert!(
            opened.lock().unwrap().is_empty(),
            "nothing opened for another host"
        );
        assert_eq!(ask(true, r#"{"open": "folder"}"#).status, 400);
        assert_eq!(
            ask(true, r#"{"open": "document", "path": "/etc/passwd"}"#).status,
            400,
            "pathless: a body naming anything else is refused"
        );
        let answer = ask(true, r#"{"open": "document"}"#);
        assert_eq!(answer.status, 200, "{}", answer.body);
        assert_eq!(
            *opened.lock().unwrap(),
            vec![patch.clone()],
            "the profile patch, resolved by the server"
        );
        assert_eq!(
            std::fs::read_to_string(&patch).unwrap(),
            "",
            "an absent patch is created empty"
        );
        std::fs::write(&patch, "- insert: []\n").unwrap();
        assert_eq!(ask(true, r#"{"open": "document"}"#).status, 200);
        assert_eq!(
            std::fs::read_to_string(&patch).unwrap(),
            "- insert: []\n",
            "an existing patch is left as it is"
        );
    }
}
