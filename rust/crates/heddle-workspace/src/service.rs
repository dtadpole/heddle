//! The workspace service: the record file, read fresh on every call, reconciled with the sessions.
//!
//! Ported from `WorkspaceService` and `WorkspacePlugin` in `src/workspace/service.ts`. The TypeScript
//! plugin bootstraps from `ctx.session.list()` on every load; the Rust boot does the same by calling
//! [`WorkspaceService::bootstrap`] with the session list right after constructing the service.
//!
//! The file is read on every call rather than cached, as the TypeScript build does; an internal lock
//! serializes this process's read-modify-write cycles so two HTTP requests cannot lose each other's edit.

use std::path::Path;
use std::sync::{Arc, PoisonError};

use heddle_config::{
    Env, canonical_path, canonical_path_through_ancestors, depth_of, expand_home, heddle_home,
    is_under,
};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use heddle_session::SessionMeta;

use crate::error::WorkspaceError;
use crate::record::{
    BootstrapReport, FolderStatus, WorkspaceAddition, WorkspaceOrigin, WorkspaceRecord,
    WorkspaceRemoval, WorkspaceStoreShape, WorkspaceView,
};
use heddle_session::clock::{EPOCH_ISO, iso_now};

/// The workspace plugin's configuration row: `{ file, generated }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct WorkspaceConfig {
    /// Where the record is kept; [`default_workspace_file`] when `None`. A leading `~` is expanded.
    pub file: Option<String>,
    /// Folder names a tool writes, which the tree names `generated` (the profile declares `dist`).
    #[serde(default)]
    pub generated: Vec<String>,
}

/// `heddle_home(env)/workspaces.json` — `$HEDDLE_HOME/workspaces.json`, else `~/.heddle/workspaces.json`.
pub fn default_workspace_file(env: &Env) -> String {
    heddle_home(env)
        .join("workspaces.json")
        .to_string_lossy()
        .into_owned()
}

/// The first-use folder's own name — DSH's `DEFAULT_WORKSPACE_DIRECTORY`
/// (dsh-api-workspace-controller `lib/types/default-workspace.js`). Fixed and language-neutral; the
/// workspace's first title is this same name, which the page labels *Default workspace*.
pub const DEFAULT_WORKSPACE_DIRECTORY: &str = "default-workspace";

/// Where first use puts its workspace: `$HEDDLE_HOME/default-workspace`, else
/// `~/.heddle/default-workspace` (`defaultWorkspaceDirectory` in `src/workspace/service.ts`). DSH uses
/// `<Documents>/deepseek-harness/default-workspace`; heddle's counterpart of that product folder is its own
/// home, so first use never reaches into the user's Documents.
pub fn default_workspace_directory(env: &Env) -> String {
    heddle_home(env)
        .join(DEFAULT_WORKSPACE_DIRECTORY)
        .to_string_lossy()
        .into_owned()
}

/// Receives the line naming an unreadable workspace list ([`unreadable_registry_line`]).
pub type Warn = Arc<dyn Fn(&str) + Send + Sync>;

/// The line the server prints, once, when the workspace list cannot be read — the TypeScript build's
/// `unreadableRegistryLine` word for word (#196). It names the whole path, and for a file that is not JSON the
/// parser's own words in brackets, which say where; those are each build's own parser's, so they stay out of the HTTP
/// answer ([`WorkspaceError::RegistryUnreadable`]), whose words are the same on both builds.
pub fn unreadable_registry_line(path: &str, reason: &str, detail: Option<&str>) -> String {
    let because = match detail {
        Some(detail) => format!("{reason} ({detail})"),
        None => reason.to_string(),
    };
    format!(
        "heddle workspace: unreadable workspace list {path}: {because}; it is left as it is, and every workspace change is refused until it reads"
    )
}

/// Why the record file is not a workspace list: the reason both builds word the same way, and the parser's detail.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Damage {
    reason: String,
    detail: Option<String>,
}

impl Damage {
    fn new(reason: impl Into<String>) -> Self {
        Damage {
            reason: reason.into(),
            detail: None,
        }
    }

    fn not_a_list(what: &str) -> Self {
        Damage::new(format!("not a workspace list: {what}"))
    }
}

/// Read and judge the record file (#196) — `judgeRegistry` in `src/workspace/service.ts`, with the same reasons. A
/// file that does not exist is the empty record of a fresh home; one that exists and does not read whole is a
/// [`Damage`]:
///
/// - an I/O failure: `permission denied`, `it is a folder, not a file`, else `it cannot be read (<kind>)`;
/// - bytes that are not UTF-8: `not UTF-8 text`;
/// - nothing but JSON whitespace: `the file is empty`, which is what a truncate-then-write leaves when the write fails;
/// - text that is not JSON: `not valid JSON`, with serde_json's words, which say where, kept for the server's line;
/// - JSON that is not a workspace list: `not a workspace list: …`, naming what is wrong.
///
/// What a version-1 or hand-made file may leave out still reads with its defaults: a missing `workspaces` or
/// `workspaceIds`, a record with no `id`, `origin` or times. A record without a string `path` and `title` used to be
/// skipped, and the next write dropped it for good; it is now a reason, as a record that does not match is
/// `invalid-record` in DSH (dsh-storage-domain lib/index.js:419-433).
fn judge_registry(file: &str) -> Result<WorkspaceStoreShape, Damage> {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceStoreShape::default());
        }
        Err(error) => return Err(Damage::new(io_reason(&error))),
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Err(Damage::new("not UTF-8 text"));
    };
    if text
        .trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
        .is_empty()
    {
        return Err(Damage::new("the file is empty"));
    }
    let value: Value = serde_json::from_str(text).map_err(|error| Damage {
        reason: "not valid JSON".to_string(),
        detail: Some(error.to_string()),
    })?;
    shape_of(&value)
}

/// An I/O failure in the TypeScript build's words; the kind alone otherwise, because an I/O error's message can carry
/// the absolute path and the reason reaches HTTP answers.
fn io_reason(error: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::PermissionDenied => "permission denied".to_string(),
        ErrorKind::IsADirectory => "it is a folder, not a file".to_string(),
        kind => format!("it cannot be read ({kind:?})"),
    }
}

/// A parsed file as the workspace list, or why it is not one (see [`judge_registry`]).
fn shape_of(value: &Value) -> Result<WorkspaceStoreShape, Damage> {
    let Value::Object(document) = value else {
        return Err(Damage::not_a_list("it is not a JSON object"));
    };
    let workspace_ids = match document.get("workspaceIds") {
        None => Vec::new(),
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| id.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| Damage::not_a_list("\"workspaceIds\" is not a list of ids"))?,
        Some(_) => return Err(Damage::not_a_list("\"workspaceIds\" is not a list of ids")),
    };
    let records = match document.get("workspaces") {
        None => None,
        Some(Value::Object(records)) => Some(records),
        Some(_) => return Err(Damage::not_a_list("\"workspaces\" is not an object")),
    };
    let mut workspaces = IndexMap::new();
    for (key, record) in records.into_iter().flatten() {
        let fields = match record {
            Value::Object(fields) => Some(fields),
            _ => None,
        };
        let (Some(path), Some(title)) = (
            fields
                .and_then(|fields| fields.get("path"))
                .and_then(Value::as_str),
            fields
                .and_then(|fields| fields.get("title"))
                .and_then(Value::as_str),
        ) else {
            return Err(Damage::not_a_list(&format!(
                "workspace \"{key}\" needs a path and a title"
            )));
        };
        let field = |name: &str| {
            fields
                .and_then(|fields| fields.get(name))
                .and_then(Value::as_str)
        };
        // Rebuilt field by field, so a version-1 file's `sessionIds` is dropped on the way in as well as on the way
        // out.
        workspaces.insert(
            key.clone(),
            WorkspaceRecord {
                id: field("id").unwrap_or(key).to_string(),
                path: path.to_string(),
                title: title.to_string(),
                origin: if field("origin") == Some("auto") {
                    WorkspaceOrigin::Auto
                } else {
                    WorkspaceOrigin::Added
                },
                created_at: field("createdAt").unwrap_or(EPOCH_ISO).to_string(),
                updated_at: field("updatedAt").unwrap_or(EPOCH_ISO).to_string(),
            },
        );
    }
    Ok(WorkspaceStoreShape {
        version: 3,
        workspace_ids,
        workspaces,
        default_workspace_id: document
            .get("defaultWorkspaceId")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Replace the record file whole: a temporary file beside it, synced, renamed over it, and the folder synced — DSH's
/// `writeAtomic` (dsh-storage-json lib/index.js:25-40), and `writeFileAtomic` in `src/workspace/service.ts`. A write that
/// fails, or a process killed in the middle of one, leaves the old file as it was. The crate's own, rather than
/// `heddle_session::write_atomic`, so the session store's writers and this one change independently, and because the
/// record is written rarely enough to afford the sync DSH does.
fn write_file_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temporary = path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return written;
    }
    // A platform that cannot sync a folder still has the rename, which is what a reader needs.
    if let Some(parent) = path.parent()
        && let Ok(folder) = std::fs::File::open(parent)
    {
        let _ = folder.sync_all();
    }
    Ok(())
}

/// The workspace service.
pub struct WorkspaceService {
    file: String,
    generated: Vec<String>,
    default_directory: String,
    lock: std::sync::Mutex<()>,
    /// Where the line naming an unreadable workspace list goes ([`unreadable_registry_line`]); standard error unless
    /// [`WorkspaceService::set_warn`] names a collector.
    warn: std::sync::Mutex<Option<Warn>>,
    /// The unreadable state last named, `(reason, detail)`, so one damage is one line however often it is read; a read
    /// that succeeds forgets it, so a later damage is named again.
    reported: std::sync::Mutex<Option<Damage>>,
}

impl std::fmt::Debug for WorkspaceService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceService")
            .field("file", &self.file)
            .field("generated", &self.generated)
            .field("default_directory", &self.default_directory)
            .finish_non_exhaustive()
    }
}

impl WorkspaceService {
    /// A service over the configured record file (a leading `~` expanded). Does not touch the disk.
    pub fn new(config: &WorkspaceConfig, env: &Env) -> Self {
        let file = config
            .file
            .clone()
            .unwrap_or_else(|| default_workspace_file(env));
        let expanded = expand_home(&file, env);
        WorkspaceService {
            file: canonical_path(&expanded).to_string_lossy().into_owned(),
            generated: config.generated.clone(),
            default_directory: default_workspace_directory(env),
            lock: std::sync::Mutex::new(()),
            warn: std::sync::Mutex::new(None),
            reported: std::sync::Mutex::new(None),
        }
    }

    /// Send the line naming an unreadable workspace list ([`unreadable_registry_line`]) to `warn` instead of standard
    /// error.
    pub fn set_warn(&self, warn: Warn) {
        *self.warn.lock().unwrap_or_else(PoisonError::into_inner) = Some(warn);
    }

    /// The record file's absolute path.
    pub fn file(&self) -> &str {
        &self.file
    }

    /// The folder [`WorkspaceService::initialize_default`] creates or reuses
    /// ([`default_workspace_directory`] of the environment the service was made with).
    pub fn default_directory(&self) -> &str {
        &self.default_directory
    }

    /// The configured generated-folder names.
    pub fn generated(&self) -> &[String] {
        &self.generated
    }

    /// The whole record, read from disk each time rather than cached.
    ///
    /// A file that does not exist is the empty record of a fresh home. A file that exists and does not read whole is
    /// [`WorkspaceError::RegistryUnreadable`] — never the empty record, because every write starts from what this
    /// answers, and an empty answer was written straight over the damaged file (#196). The first read of a damage
    /// prints one line naming the file ([`unreadable_registry_line`]).
    pub fn read(&self) -> Result<WorkspaceStoreShape, WorkspaceError> {
        let damage = match judge_registry(&self.file) {
            Ok(shape) => {
                *self.reported.lock().unwrap_or_else(PoisonError::into_inner) = None;
                return Ok(shape);
            }
            Err(damage) => damage,
        };
        let first = {
            let mut reported = self.reported.lock().unwrap_or_else(PoisonError::into_inner);
            let first = reported.as_ref() != Some(&damage);
            *reported = Some(damage.clone());
            first
        };
        if first {
            let line =
                unreadable_registry_line(&self.file, &damage.reason, damage.detail.as_deref());
            let warn = self
                .warn
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            match warn {
                Some(warn) => warn(&line),
                None => eprintln!("{line}"),
            }
        }
        Err(self.unreadable(damage))
    }

    /// Whether the record reads: [`WorkspaceError::RegistryUnreadable`] when it does not, before a caller writes
    /// anything else (the turn route asks it before it opens a session in a folder it would adopt).
    pub fn check(&self) -> Result<(), WorkspaceError> {
        self.read().map(|_| ())
    }

    fn unreadable(&self, damage: Damage) -> WorkspaceError {
        WorkspaceError::RegistryUnreadable {
            path: self.file.clone(),
            name: Path::new(&self.file)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.file.clone()),
            reason: damage.reason,
            detail: damage.detail,
        }
    }

    /// Write the record whole ([`write_file_atomic`]), creating its directory, and never over a file that does not
    /// read (#196): every write here starts from [`WorkspaceService::read`], which already refuses one, and the file is
    /// judged again at the last moment, so a file damaged in between — or one this process may not read, which a
    /// rename would otherwise replace — is refused rather than replaced.
    fn write(&self, shape: &WorkspaceStoreShape) -> Result<(), WorkspaceError> {
        if let Err(damage) = judge_registry(&self.file) {
            return Err(self.unreadable(damage));
        }
        if let Some(parent) = Path::new(&self.file).parent() {
            std::fs::create_dir_all(parent).map_err(|error| WorkspaceError::Io {
                path: parent.to_string_lossy().into_owned(),
                source: error,
            })?;
        }
        write_file_atomic(Path::new(&self.file), &shape.to_file_text()).map_err(|error| {
            WorkspaceError::Io {
                path: self.file.clone(),
                source: error,
            }
        })
    }

    /// Every workspace in `workspaceIds` order; [`WorkspaceError::RegistryUnreadable`] when the record does not read.
    pub fn list(&self) -> Result<Vec<WorkspaceRecord>, WorkspaceError> {
        Ok(Self::ordered(&self.read()?))
    }

    /// The records of `shape` in `workspaceIds` order.
    fn ordered(shape: &WorkspaceStoreShape) -> Vec<WorkspaceRecord> {
        shape
            .workspace_ids
            .iter()
            .filter_map(|id| shape.workspaces.get(id).cloned())
            .collect()
    }

    /// The record for a path, creating it when there is none (title: the last path segment). An
    /// existing `auto` record asked for as `added` is promoted. A new record is prepended to the order.
    pub fn ensure(
        &self,
        path: &str,
        title: Option<&str>,
        origin: Option<WorkspaceOrigin>,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        let _guard = self
            .lock
            .lock()
            .expect("the workspace lock is never poisoned");
        let canonical = canonical_path(Path::new(path))
            .to_string_lossy()
            .into_owned();
        let mut shape = self.read()?;
        if let Some(existing) = shape
            .workspaces
            .values()
            .find(|record| record.path == canonical)
            .cloned()
        {
            // Registering an adopted folder **promotes** it rather than duplicating it, so the ad-hoc
            // group is a staging area.
            if origin == Some(WorkspaceOrigin::Added) && existing.origin != WorkspaceOrigin::Added {
                let promoted = WorkspaceRecord {
                    origin: WorkspaceOrigin::Added,
                    updated_at: iso_now(),
                    ..existing.clone()
                };
                shape
                    .workspaces
                    .insert(existing.id.clone(), promoted.clone());
                self.write(&shape)?;
                return Ok(promoted);
            }
            return Ok(existing);
        }

        let now = iso_now();
        let title = title
            .map(str::to_string)
            .or_else(|| {
                canonical
                    .rsplit('/')
                    .find(|segment| !segment.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| canonical.clone());
        let record = WorkspaceRecord {
            id: uuid::Uuid::new_v4().to_string(),
            path: canonical,
            title,
            origin: origin.unwrap_or(WorkspaceOrigin::Added),
            created_at: now.clone(),
            updated_at: now,
        };
        shape.workspaces.insert(record.id.clone(), record.clone());
        // Newest first, which is how DSH orders its workspace list.
        shape.workspace_ids.insert(0, record.id.clone());
        self.write(&shape)?;
        Ok(record)
    }

    /// Register a target folder (`added`), reporting whether this call created the record.
    pub fn add(
        &self,
        path: &str,
        title: Option<&str>,
    ) -> Result<WorkspaceAddition, WorkspaceError> {
        let before = self.find(path)?;
        let record = self.ensure(path, title, Some(WorkspaceOrigin::Added))?;
        Ok(WorkspaceAddition {
            record,
            created: before.is_none(),
        })
    }

    /// First use: create or reuse the default workspace in [`WorkspaceService::default_directory`] — DSH's
    /// `workspace/initializeDefault` (dsh-workspace `lib/index.js:425-440`), `initializeDefault` in
    /// `src/workspace/service.ts`.
    ///
    /// Once a first use has happened the answer is that workspace, or `None` when its registration was
    /// deleted (deleting it turns first use off for good). Otherwise it applies only to an empty install —
    /// no workspace record of any kind and no session in `all` — and anything else is `Ok(None)`, not an
    /// error. The folder is made when missing and reused when present; the workspace is `added`, titled
    /// [`DEFAULT_WORKSPACE_DIRECTORY`]. No session is started.
    pub fn initialize_default(
        &self,
        all: &[SessionMeta],
    ) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
        let _guard = self
            .lock
            .lock()
            .expect("the workspace lock is never poisoned");
        let shape = self.read()?;
        if let Some(id) = &shape.default_workspace_id {
            return Ok(shape.workspaces.get(id).cloned());
        }
        if !shape.workspace_ids.is_empty() || !shape.workspaces.is_empty() || !all.is_empty() {
            return Ok(None);
        }
        std::fs::create_dir_all(&self.default_directory).map_err(|error| WorkspaceError::Io {
            path: self.default_directory.clone(),
            source: error,
        })?;
        let now = iso_now();
        let record = WorkspaceRecord {
            id: uuid::Uuid::new_v4().to_string(),
            path: canonical_path(Path::new(&self.default_directory))
                .to_string_lossy()
                .into_owned(),
            title: DEFAULT_WORKSPACE_DIRECTORY.to_string(),
            origin: WorkspaceOrigin::Added,
            created_at: now.clone(),
            updated_at: now,
        };
        self.write(&WorkspaceStoreShape {
            version: 3,
            workspace_ids: vec![record.id.clone()],
            workspaces: IndexMap::from([(record.id.clone(), record.clone())]),
            default_workspace_id: Some(record.id.clone()),
        })?;
        Ok(Some(record))
    }

    /// Unregister a root by id or path.
    ///
    /// Nothing under it: removed. Sessions under it and a root above: removed, and the report names the
    /// adopting root. Sessions under it and nothing above: [`WorkspaceError::StillHoldsSessions`] unless
    /// `force`. An unknown root: [`WorkspaceError::NotFound`].
    pub fn remove(
        &self,
        id_or_path: &str,
        all: &[SessionMeta],
        force: bool,
    ) -> Result<WorkspaceRemoval, WorkspaceError> {
        let _guard = self
            .lock
            .lock()
            .expect("the workspace lock is never poisoned");
        let mut shape = self.read()?;
        let record = Self::find_in(&shape, id_or_path)
            .ok_or_else(|| WorkspaceError::NotFound(id_or_path.to_string()))?;
        let owned = Self::sessions_among(&record, all, &Self::ordered(&shape));
        let others: Vec<WorkspaceRecord> = shape
            .workspaces
            .values()
            .filter(|entry| entry.id != record.id)
            .cloned()
            .collect();
        let parent_dir = Path::new(&record.path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_else(|| record.path.clone());
        let parent = Self::owner_among(&parent_dir, &others);
        if !owned.is_empty() && parent.is_none() && !force {
            return Err(WorkspaceError::StillHoldsSessions {
                title: record.title.clone(),
                path: record.path.clone(),
                sessions: owned.len(),
            });
        }
        shape.workspaces.shift_remove(&record.id);
        shape.workspace_ids.retain(|id| id != &record.id);
        self.write(&shape)?;
        Ok(WorkspaceRemoval {
            removed: record,
            owned_sessions: owned.len(),
            adopted_by: parent.map(|parent| parent.title),
        })
    }

    /// One workspace by id, else by canonical path.
    ///
    /// A path whose folder is gone is matched through the real path of its deepest existing ancestor as well (#141;
    /// `find` in `src/workspace/service.ts`): the record was stored canonical while the folder existed, and a spelling
    /// through a link (`/tmp/x/w` for `/private/tmp/x/w`) no longer resolves once it is deleted or moved.
    pub fn find(&self, id_or_path: &str) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
        Ok(Self::find_in(&self.read()?, id_or_path))
    }

    /// [`WorkspaceService::find`] in a record already read.
    fn find_in(shape: &WorkspaceStoreShape, id_or_path: &str) -> Option<WorkspaceRecord> {
        if let Some(record) = shape.workspaces.get(id_or_path) {
            return Some(record.clone());
        }
        let canonical = canonical_path(Path::new(id_or_path))
            .to_string_lossy()
            .into_owned();
        let at = |path: &str| {
            shape
                .workspaces
                .values()
                .find(|record| record.path == path)
                .cloned()
        };
        at(&canonical).or_else(|| {
            let located = canonical_path_through_ancestors(Path::new(id_or_path))
                .to_string_lossy()
                .into_owned();
            (located != canonical).then(|| at(&located)).flatten()
        })
    }

    /// Whether a folder is gone, for the tree route (#141; `missingFolder` in `src/workspace/service.ts`): `None`
    /// when it exists; otherwise where it was — its canonical spelling through its deepest existing ancestor — and
    /// the root that owns that place, if any. DSH answers a directory that is not there with
    /// `workspace-file/not-found` (dsh-api-workspace-files lib/index.js:568) and its tree says it is gone
    /// (dsh-client-ui-sidebar-files lib/client.js:485). A missing folder behind a link out of every root is
    /// judged where the link lands: outside.
    pub fn missing_folder(
        &self,
        path: &str,
    ) -> Result<Option<(String, Option<WorkspaceRecord>)>, WorkspaceError> {
        let located = canonical_path_through_ancestors(Path::new(path));
        if located.exists() {
            return Ok(None);
        }
        let located = located.to_string_lossy().into_owned();
        let owner = self.owner(&located)?;
        Ok(Some((located, owner)))
    }

    /// Retitle a root by id or path; the path never changes. `Ok(None)` for an unknown root,
    /// [`WorkspaceError::EmptyName`] for a blank title, [`WorkspaceError::NameConflict`] for a title another
    /// `added` root already carries (DSH's rule; adopted roots are never drawn as workspaces, so they do not
    /// count). Confirming the current title changes nothing.
    pub fn rename(
        &self,
        id_or_path: &str,
        title: &str,
    ) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
        let _guard = self
            .lock
            .lock()
            .expect("the workspace lock is never poisoned");
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(WorkspaceError::EmptyName);
        }
        let mut shape = self.read()?;
        let Some(record) = Self::find_in(&shape, id_or_path) else {
            return Ok(None);
        };
        if record.title == trimmed {
            return Ok(Some(record));
        }
        let clash = shape.workspaces.values().any(|entry| {
            entry.id != record.id && entry.origin != WorkspaceOrigin::Auto && entry.title == trimmed
        });
        if clash {
            return Err(WorkspaceError::NameConflict(trimmed.to_string()));
        }
        let updated = WorkspaceRecord {
            title: trimmed.to_string(),
            updated_at: iso_now(),
            ..record.clone()
        };
        shape.workspaces.insert(record.id.clone(), updated.clone());
        self.write(&shape)?;
        Ok(Some(updated))
    }

    /// Move one workspace within the stored order, DOM-`insertBefore`-like — DSH's `workspace/insertBefore`
    /// (dsh-workspace lib/index.js:473-499). `insertBefore` in `src/workspace/service.ts`.
    ///
    /// With an anchor the workspace lands just before it; with `None` it goes to the end. Both are named by id
    /// or by path; either missing from the order is [`WorkspaceError::OrderInvalid`]. Naming itself as its
    /// anchor, or a move that changes nothing, writes nothing. The order is the `workspaceIds` array a new root
    /// is prepended to, so the file keeps its shape. Answers the complete order.
    pub fn insert_before(
        &self,
        id_or_path: &str,
        before: Option<&str>,
    ) -> Result<Vec<String>, WorkspaceError> {
        self.reorder(id_or_path, before).map(|(order, _)| order)
    }

    /// [`WorkspaceService::insert_before`], saying whether anything moved — what the route needs to announce a move
    /// to every open page and to stay quiet about one that changes nothing (#136; `reorder` in
    /// `src/workspace/service.ts`). DSH's `insertBefore` returns before it writes when the workspace is its own
    /// anchor or the order would not change (dsh-workspace lib/index.js:484, :492).
    pub fn reorder(
        &self,
        id_or_path: &str,
        before: Option<&str>,
    ) -> Result<(Vec<String>, bool), WorkspaceError> {
        let _guard = self
            .lock
            .lock()
            .expect("the workspace lock is never poisoned");
        let mut shape = self.read()?;
        let listed = |key: &str| {
            Self::find_in(&shape, key)
                .map(|record| record.id)
                .filter(|id| shape.workspace_ids.contains(id))
                .ok_or_else(|| WorkspaceError::OrderInvalid(key.to_string()))
        };
        let id = listed(id_or_path)?;
        let before = before.map(listed).transpose()?;
        if before.as_deref() == Some(id.as_str()) {
            return Ok((shape.workspace_ids, false));
        }
        let mut order: Vec<String> = shape
            .workspace_ids
            .iter()
            .filter(|each| **each != id)
            .cloned()
            .collect();
        let at = match &before {
            Some(anchor) => order
                .iter()
                .position(|each| each == anchor)
                .unwrap_or(order.len()),
            None => order.len(),
        };
        order.insert(at, id);
        if order == shape.workspace_ids {
            return Ok((order, false));
        }
        shape.workspace_ids = order.clone();
        self.write(&shape)?;
        Ok((order, true))
    }

    /// The root that owns a folder: the **nearest** registered root at or above it.
    pub fn owner(&self, path: &str) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
        Ok(Self::owner_among(path, &self.list()?))
    }

    /// The nearest of `records` at or above `path` — [`WorkspaceService::owner`] over a given set.
    pub fn owner_among(path: &str, records: &[WorkspaceRecord]) -> Option<WorkspaceRecord> {
        let canonical = canonical_path(Path::new(path));
        let mut best: Option<(WorkspaceRecord, usize)> = None;
        for record in records {
            if !is_under(Path::new(&record.path), &canonical) {
                continue;
            }
            let depth = depth_of(Path::new(&record.path));
            // A stable `sort().find()` keeps the first of two roots at the same depth.
            if best.as_ref().map(|(_, best)| depth > *best).unwrap_or(true) {
                best = Some((record.clone(), depth));
            }
        }
        best.map(|(record, _)| record)
    }

    /// The sessions a root accounts for: bound at or below it, minus those a nearer root owns, in the
    /// order given (the store's newest first).
    pub fn sessions(
        &self,
        record: &WorkspaceRecord,
        all: &[SessionMeta],
    ) -> Result<Vec<SessionMeta>, WorkspaceError> {
        Ok(Self::sessions_among(record, all, &self.list()?))
    }

    /// [`WorkspaceService::sessions`] among `records`, already read.
    pub fn sessions_among(
        record: &WorkspaceRecord,
        all: &[SessionMeta],
        records: &[WorkspaceRecord],
    ) -> Vec<SessionMeta> {
        all.iter()
            .filter(|meta| {
                let canonical = canonical_path(Path::new(meta.cwd()));
                if !is_under(Path::new(&record.path), &canonical) {
                    return false;
                }
                Self::owner_among(&canonical.to_string_lossy(), records)
                    .map(|owner| owner.id == record.id)
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    /// Every workspace with its parent and its sessions — what `GET /api/workspaces` answers. See
    /// [`workspace_views`].
    ///
    /// Each carries its folder's `status`, read now: DSH's `Workspace.status()`, uncached and never changing the
    /// record (dsh-workspace lib/index.js:154-160). A workspace whose folder was deleted or moved stays listed, as
    /// DSH keeps it, and the page tells it apart (#141).
    pub fn views(&self, all: &[SessionMeta]) -> Result<Vec<WorkspaceView>, WorkspaceError> {
        Ok(workspace_views(&self.list()?, all)
            .into_iter()
            .map(|view| WorkspaceView {
                status: Some(FolderStatus::of(Path::new(&view.path))),
                ..view
            })
            .collect())
    }

    /// The root that owns a folder, adopting the folder itself (`auto`) when nothing above it does.
    pub fn ensure_owner(&self, path: &str) -> Result<WorkspaceRecord, WorkspaceError> {
        let canonical = canonical_path(Path::new(path))
            .to_string_lossy()
            .into_owned();
        match self.owner(&canonical)? {
            Some(record) => Ok(record),
            None => self.ensure(&canonical, None, Some(WorkspaceOrigin::Auto)),
        }
    }

    /// Group every session under the nearest root above it, adopting a root where there is none.
    /// Idempotent.
    ///
    /// A record that cannot be read is **not** rebuilt from the sessions (#196): that rebuild wrote at once, so an
    /// empty or damaged file became a list of adopted folders and every registration, title and order was lost. The
    /// start goes on with the line [`WorkspaceService::read`] printed, adopts nothing, writes nothing, and reports
    /// `skipped` — `bootstrap` in `src/workspace/service.ts`.
    pub fn bootstrap(&self, all: &[SessionMeta]) -> Result<BootstrapReport, WorkspaceError> {
        let mut attached = 0usize;
        let mut created = 0usize;
        let pass = (|| {
            for meta in all {
                let canonical = canonical_path(Path::new(meta.cwd()))
                    .to_string_lossy()
                    .into_owned();
                if self.owner(&canonical)?.is_none() {
                    self.ensure(&canonical, None, Some(WorkspaceOrigin::Auto))?;
                    created += 1;
                }
                attached += 1;
            }
            self.list()
        })();
        match pass {
            Ok(records) => Ok(BootstrapReport {
                workspaces: records.len(),
                attached,
                created,
                skipped: false,
            }),
            Err(WorkspaceError::RegistryUnreadable { .. }) => Ok(BootstrapReport {
                workspaces: 0,
                attached,
                created,
                skipped: true,
            }),
            Err(error) => Err(error),
        }
    }
}

/// Every workspace with its parent and its sessions, in the order of `records` — `workspaceViews` in
/// `src/workspace/service.ts`. `parent` is the nearest other record strictly above a record's path
/// (segment-wise); a session belongs to its nearest record at or above its canonical `cwd`, and the
/// order of `all` is kept. Archived and subagent sessions are included; the reader filters.
pub fn workspace_views(records: &[WorkspaceRecord], all: &[SessionMeta]) -> Vec<WorkspaceView> {
    let mut owned: IndexMap<String, Vec<String>> = IndexMap::new();
    for meta in all {
        let canonical = canonical_path(Path::new(meta.cwd()));
        if let Some(owner) = WorkspaceService::owner_among(&canonical.to_string_lossy(), records) {
            owned
                .entry(owner.id)
                .or_default()
                .push(meta.id().to_string());
        }
    }
    records
        .iter()
        .map(|record| {
            let mut parent: Option<(&WorkspaceRecord, usize)> = None;
            for other in records {
                if other.id == record.id
                    || other.path == record.path
                    || !is_under(Path::new(&other.path), Path::new(&record.path))
                {
                    continue;
                }
                let depth = depth_of(Path::new(&other.path));
                if parent.map(|(_, best)| depth > best).unwrap_or(true) {
                    parent = Some((other, depth));
                }
            }
            WorkspaceView {
                id: record.id.clone(),
                path: record.path.clone(),
                title: record.title.clone(),
                origin: record.origin,
                parent: parent.map(|(other, _)| other.id.clone()),
                created_at: record.created_at.clone(),
                updated_at: record.updated_at.clone(),
                session_ids: owned.get(&record.id).cloned().unwrap_or_default(),
                status: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn service() -> (tempfile::TempDir, WorkspaceService) {
        let dir = tempfile::tempdir().unwrap();
        let config = WorkspaceConfig {
            file: Some(
                dir.path()
                    .join("workspaces.json")
                    .to_str()
                    .unwrap()
                    .to_string(),
            ),
            generated: vec!["dist".to_string()],
        };
        let service = WorkspaceService::new(&config, &Env::default());
        (dir, service)
    }

    fn meta(id: &str, cwd: &str) -> SessionMeta {
        SessionMeta::from_value(json!({
            "id": id,
            "created": "2026-10-22T18:17:41.123Z",
            "cwd": cwd,
            "turns": 1,
        }))
        .unwrap()
    }

    fn cwd(path: &str) -> String {
        canonical_path(Path::new(path))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn an_empty_service_reads_as_an_empty_record() {
        let (_dir, service) = service();
        assert_eq!(service.read().unwrap(), WorkspaceStoreShape::default());
        assert!(service.list().unwrap().is_empty());
        assert_eq!(service.find("/nowhere").unwrap(), None);
    }

    #[test]
    fn a_version_one_file_loses_its_session_ids_and_gains_the_missing_defaults() {
        let (dir, service) = service();
        std::fs::write(
            service.file(),
            "{\n  \"version\": 1,\n  \"workspaceIds\": [\"w-1\"],\n  \"workspaces\": {\n    \"w-1\": {\n      \"path\": \"/work/one\",\n      \"title\": \"one\",\n      \"sessionIds\": [\"session-1\"]\n    }\n  }\n}\n",
        )
        .unwrap();
        let shape = service.read().unwrap();
        assert_eq!(shape.version, 3);
        let record = shape.workspaces.get("w-1").unwrap();
        assert_eq!(record.id, "w-1", "a record without an id takes the map key");
        assert_eq!(record.origin, WorkspaceOrigin::Added);
        assert_eq!(record.created_at, EPOCH_ISO);
        assert_eq!(record.updated_at, EPOCH_ISO);

        // Reading wrote nothing; adding a second root rewrites the file without the legacy field.
        service.add("/work/two", Some("two")).unwrap();
        let text = std::fs::read_to_string(service.file()).unwrap();
        assert!(!text.contains("sessionIds"));
        assert!(text.starts_with("{\n  \"version\": 3,\n  \"workspaceIds\": [\n"));
        let _ = dir;
    }

    #[test]
    fn a_new_record_is_prepended_and_an_adopted_one_is_promoted() {
        let (_dir, service) = service();
        let first = service.add("/work/one", Some("one")).unwrap();
        assert!(first.created);
        let second = service.add("/work/two", None).unwrap();
        assert!(second.created);
        assert_eq!(
            second.record.title, "two",
            "a title defaults to the last segment"
        );
        let listed = service.list().unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|record| record.title.as_str())
                .collect::<Vec<_>>(),
            vec!["two", "one"]
        );

        // Adopting a folder and then registering it promotes the same record.
        let adopted = service
            .ensure("/work/three", None, Some(WorkspaceOrigin::Auto))
            .unwrap();
        assert_eq!(adopted.origin, WorkspaceOrigin::Auto);
        assert_eq!(service.list().unwrap().len(), 3);
        let promoted = service.add("/work/three", Some("three")).unwrap();
        assert!(!promoted.created, "the record already existed");
        assert_eq!(promoted.record.id, adopted.id);
        assert_eq!(promoted.record.origin, WorkspaceOrigin::Added);
        assert_eq!(service.list().unwrap().len(), 3);
    }

    #[test]
    fn insert_before_moves_a_workspace_and_the_order_is_kept_in_the_same_file_shape() {
        let (_dir, service) = service();
        let one = service.add("/work/one", Some("one")).unwrap().record.id;
        let two = service.add("/work/two", Some("two")).unwrap().record.id;
        let three = service.add("/work/three", Some("three")).unwrap().record.id;
        let titles = |service: &WorkspaceService| {
            service
                .list()
                .unwrap()
                .into_iter()
                .map(|record| record.title)
                .collect::<Vec<_>>()
        };
        assert_eq!(titles(&service), vec!["three", "two", "one"]);

        // Before an anchor (DSH: `insertBefore(id, beforeId)`), named by id or by path; the answer is the
        // complete order.
        let order = service.insert_before(&one, Some(&three)).unwrap();
        assert_eq!(order, vec![one.clone(), three.clone(), two.clone()]);
        assert_eq!(titles(&service), vec!["one", "three", "two"]);
        service
            .insert_before("/work/two", Some("/work/three"))
            .unwrap();
        assert_eq!(titles(&service), vec!["one", "two", "three"]);
        // No anchor appends.
        service.insert_before(&one, None).unwrap();
        assert_eq!(titles(&service), vec!["two", "three", "one"]);

        // Itself as the anchor, or a move that changes nothing, writes nothing.
        let before = std::fs::read_to_string(service.file()).unwrap();
        let modified = std::fs::metadata(service.file())
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            service.insert_before(&three, Some(&three)).unwrap(),
            vec![two.clone(), three.clone(), one.clone()]
        );
        service.insert_before(&two, Some(&three)).unwrap();
        service.insert_before(&one, None).unwrap();
        assert_eq!(std::fs::read_to_string(service.file()).unwrap(), before);
        assert_eq!(
            std::fs::metadata(service.file())
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );

        // An unknown workspace or anchor is refused with DSH's sentence, and nothing moves.
        let unknown = service.insert_before("w-nowhere", None).unwrap_err();
        assert!(matches!(&unknown, WorkspaceError::OrderInvalid(id) if id == "w-nowhere"));
        assert_eq!(
            unknown.to_string(),
            "cannot reorder unknown workspace 'w-nowhere'"
        );
        assert!(matches!(
            service.insert_before(&one, Some("w-nowhere")).unwrap_err(),
            WorkspaceError::OrderInvalid(id) if id == "w-nowhere"
        ));
        assert_eq!(titles(&service), vec!["two", "three", "one"]);

        // The file keeps its shape: the same three keys, the order in `workspaceIds`, no new field.
        let text = std::fs::read_to_string(service.file()).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["version", "workspaceIds", "workspaces"]
        );
        assert_eq!(value["workspaceIds"], json!([two, three, one]));
        assert_eq!(text, service.read().unwrap().to_file_text());

        // A new workspace is still prepended to the moved order (DSH: lib/index.js:402).
        service.add("/work/four", Some("four")).unwrap();
        assert_eq!(titles(&service), vec!["four", "two", "three", "one"]);
    }

    #[test]
    fn the_nearest_root_owns_a_folder_and_a_sibling_is_not_a_member() {
        let (dir, service) = service();
        let root = dir.path().join("root");
        let inner = root.join("inner");
        let sibling = dir.path().join("root-sibling");
        for path in [&root, &inner, &sibling] {
            std::fs::create_dir_all(path).unwrap();
        }
        service.add(root.to_str().unwrap(), Some("root")).unwrap();
        let inner_record = service
            .add(inner.to_str().unwrap(), Some("inner"))
            .unwrap()
            .record;
        let sibling_record = service
            .add(sibling.to_str().unwrap(), Some("sibling"))
            .unwrap()
            .record;

        let deep = inner.join("deep");
        std::fs::create_dir_all(&deep).unwrap();
        let sessions = vec![meta("session-1", deep.to_str().unwrap())];
        assert_eq!(
            service.owner(deep.to_str().unwrap()).unwrap().unwrap().id,
            inner_record.id,
            "the nearest root owns a session"
        );
        assert_eq!(service.sessions(&inner_record, &sessions).unwrap().len(), 1);
        let outer = service.find(root.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(
            service.sessions(&outer, &sessions).unwrap().len(),
            0,
            "the outer root does not claim it as well"
        );

        // A sibling whose path shares every character of the root is not inside it.
        let sibling_sessions = vec![meta("session-2", sibling.to_str().unwrap())];
        assert_eq!(
            service.sessions(&outer, &sibling_sessions).unwrap().len(),
            0
        );
        assert_eq!(
            service
                .sessions(&sibling_record, &sibling_sessions)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn removing_a_root_that_still_holds_sessions_is_refused_unless_forced() {
        let (dir, service) = service();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let record = service
            .add(root.to_str().unwrap(), Some("root"))
            .unwrap()
            .record;
        let sessions = vec![meta("session-1", root.to_str().unwrap())];

        let error = service.remove(&record.id, &sessions, false).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "workspace 'root' still holds 1 session(s) and no root above it, so removing it would only be undone on the next run; remove those sessions, register a root above '{}', or force it",
                record.path
            )
        );

        let removed = service.remove(&record.id, &sessions, true).unwrap();
        assert_eq!(removed.owned_sessions, 1);
        assert_eq!(removed.adopted_by, None);
        assert!(service.list().unwrap().is_empty());
        assert!(matches!(
            service.remove(&record.id, &[], false).unwrap_err(),
            WorkspaceError::NotFound(_)
        ));
    }

    #[test]
    fn removing_a_root_under_another_reports_the_adopting_root() {
        let (dir, service) = service();
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        service.add(outer.to_str().unwrap(), Some("outer")).unwrap();
        let inner_record = service
            .add(inner.to_str().unwrap(), Some("inner"))
            .unwrap()
            .record;
        let sessions = vec![meta("session-1", inner.to_str().unwrap())];

        let removed = service.remove(&inner_record.id, &sessions, false).unwrap();
        assert_eq!(removed.owned_sessions, 1);
        assert_eq!(removed.adopted_by, Some("outer".to_string()));
        assert_eq!(service.list().unwrap().len(), 1);
        assert_eq!(
            service
                .owner(inner.to_str().unwrap())
                .unwrap()
                .unwrap()
                .title,
            "outer"
        );
    }

    #[test]
    fn a_rename_refuses_a_blank_title_and_keeps_the_path() {
        let (_dir, service) = service();
        let record = service.add("/work/one", Some("one")).unwrap().record;
        let renamed = service.rename(&record.id, "  One  ").unwrap().unwrap();
        assert_eq!(renamed.title, "One");
        assert_eq!(renamed.path, record.path);
        assert!(matches!(
            service.rename(&record.id, "   ").unwrap_err(),
            WorkspaceError::EmptyName
        ));
        assert_eq!(service.rename("/no-such-root", "x").unwrap(), None);
    }

    #[test]
    fn a_rename_refuses_a_title_another_chosen_root_carries_and_keeps_its_own() {
        let (_dir, service) = service();
        let one = service.add("/work/one", Some("one")).unwrap().record;
        let two = service.add("/work/two", Some("two")).unwrap().record;
        let adopted = service
            .ensure("/work/three", Some("three"), Some(WorkspaceOrigin::Auto))
            .unwrap();
        match service.rename(&two.id, " one ").unwrap_err() {
            WorkspaceError::NameConflict(title) => assert_eq!(title, "one"),
            other => panic!("expected a name conflict, got {other:?}"),
        }
        assert_eq!(
            WorkspaceError::NameConflict("one".to_string()).to_string(),
            "A workspace named “one” already exists."
        );
        // The unchanged title is a no-op, not a conflict with itself.
        let same = service.rename(&one.id, "one").unwrap().unwrap();
        assert_eq!(same.updated_at, one.updated_at);
        // An adopted root's title does not count: the tree never draws it as a workspace.
        assert_eq!(adopted.origin, WorkspaceOrigin::Auto);
        assert_eq!(
            service.rename(&two.id, "three").unwrap().unwrap().title,
            "three"
        );
    }

    #[test]
    fn bootstrap_adopts_what_nothing_owns_and_is_idempotent() {
        let (dir, service) = service();
        let one = dir.path().join("one");
        let two = dir.path().join("two");
        for path in [&one, &two] {
            std::fs::create_dir_all(path).unwrap();
        }
        let sessions = vec![
            meta("session-1", one.to_str().unwrap()),
            meta("session-2", two.to_str().unwrap()),
            meta("session-3", two.to_str().unwrap()),
        ];
        let first = service.bootstrap(&sessions).unwrap();
        assert_eq!(first.attached, 3);
        assert_eq!(first.created, 2);
        assert_eq!(first.workspaces, 2);

        let second = service.bootstrap(&sessions).unwrap();
        assert_eq!(
            second.created, 0,
            "a session already accounted for creates nothing"
        );
        assert_eq!(second.workspaces, 2);
        assert!(
            service
                .list()
                .unwrap()
                .iter()
                .all(|record| record.origin == WorkspaceOrigin::Auto)
        );
    }

    #[test]
    fn ensure_owner_adopts_a_folder_with_no_root_above_it() {
        let (dir, service) = service();
        let folder = dir.path().join("loose");
        std::fs::create_dir_all(&folder).unwrap();
        let record = service.ensure_owner(folder.to_str().unwrap()).unwrap();
        assert_eq!(record.path, cwd(folder.to_str().unwrap()));
        assert_eq!(record.origin, WorkspaceOrigin::Auto);
        assert_eq!(record.title, "loose");
        // Asking again answers the same record.
        assert_eq!(
            service.ensure_owner(folder.to_str().unwrap()).unwrap().id,
            record.id
        );
    }

    #[test]
    fn a_workspace_view_names_its_nearest_parent_and_the_sessions_whose_nearest_root_it_is() {
        let (dir, service) = service();
        let base = dir.path().join("work");
        let outer = base.join("outer");
        let middle = outer.join("packages");
        let inner = middle.join("app");
        let sibling = base.join("outer-sibling");
        for path in [&inner, &sibling, &outer.join("docs"), &inner.join("src")] {
            std::fs::create_dir_all(path).unwrap();
        }
        let text = |path: &std::path::Path| path.to_str().unwrap().to_string();
        let outer_id = service.add(&text(&outer), None).unwrap().record.id;
        let inner_id = service.add(&text(&inner), None).unwrap().record.id;
        let middle_id = service.add(&text(&middle), None).unwrap().record.id;
        let sibling_id = service.add(&text(&sibling), None).unwrap().record.id;
        let all = vec![
            meta("session-new-inner", &text(&inner.join("src"))),
            meta("session-outer", &text(&outer.join("docs"))),
            meta("session-middle", &text(&middle)),
            meta("session-old-inner", &text(&inner)),
            meta("session-sibling", &text(&sibling)),
            meta("session-nowhere", "/no/root/above/this"),
        ];
        let views = service.views(&all).unwrap();
        let ids: Vec<String> = views.iter().map(|view| view.id.clone()).collect();
        let listed: Vec<String> = service
            .list()
            .unwrap()
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(ids, listed, "in the record's own order");
        let view = |id: &str| views.iter().find(|view| view.id == id).unwrap().clone();
        assert_eq!(
            view(&outer_id).parent,
            None,
            "a top-level root has no parent"
        );
        assert_eq!(view(&middle_id).parent.as_deref(), Some(outer_id.as_str()));
        assert_eq!(
            view(&inner_id).parent.as_deref(),
            Some(middle_id.as_str()),
            "the nearest root above, not the outermost"
        );
        assert_eq!(
            view(&sibling_id).parent,
            None,
            "a shared prefix is not a parent"
        );
        assert_eq!(
            view(&inner_id).session_ids,
            vec!["session-new-inner", "session-old-inner"],
            "the inner root keeps its own, newest first"
        );
        assert_eq!(view(&middle_id).session_ids, vec!["session-middle"]);
        assert_eq!(view(&outer_id).session_ids, vec!["session-outer"]);
        assert_eq!(view(&sibling_id).session_ids, vec!["session-sibling"]);
        let accounted: Vec<String> = views
            .iter()
            .flat_map(|view| view.session_ids.clone())
            .collect();
        assert!(!accounted.contains(&"session-nowhere".to_string()));
        let json = serde_json::to_value(view(&outer_id)).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "path",
                "title",
                "origin",
                "parent",
                "createdAt",
                "updatedAt",
                "sessionIds",
                "status"
            ],
            "the TypeScript route's keys, in its order, with DSH's status last (#141)"
        );
        assert_eq!(json["status"], "ok", "a folder that is there is ok");
        assert_eq!(json["parent"], Value::Null);
        assert_eq!(json["origin"], "added");
    }

    #[test]
    fn a_workspace_view_keeps_an_adopted_roots_origin() {
        let records = vec![WorkspaceRecord {
            id: "w-auto".into(),
            path: "/tmp/heddle-views/auto".into(),
            title: "auto".into(),
            origin: WorkspaceOrigin::Auto,
            created_at: "a".into(),
            updated_at: "a".into(),
        }];
        let views = workspace_views(&records, &[meta("session-a", "/tmp/heddle-views/auto/x")]);
        assert_eq!(views[0].origin, WorkspaceOrigin::Auto);
        assert_eq!(views[0].session_ids, vec!["session-a"]);
    }

    /// One folder is one workspace however it is spelled: DSH's "one record per canonical path", with
    /// `fs.realpath` as the canon (`dsh-workspace/README.md:93`, `lib/index.js:36-51`). A letter-case variant
    /// on a case-insensitive volume and a symlink both reach the registered folder, so both report it
    /// (`created: false`) and a session started at either lists under it. `canonical_path` is `realpath(3)`,
    /// which answers with the stored spelling; the TypeScript build matches it through `realpathSync.native`.
    #[cfg(unix)]
    #[test]
    fn a_letter_case_variant_or_a_symlink_of_a_registered_folder_is_that_workspace() {
        let (dir, service) = service();
        let proj = dir.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let link = dir.path().join("proj-link");
        std::os::unix::fs::symlink(&proj, &link).unwrap();
        let first = service.add(proj.to_str().unwrap(), None).unwrap();
        assert!(first.created);

        let via_link = service.add(link.to_str().unwrap(), None).unwrap();
        assert!(
            !via_link.created,
            "a symlink to a registered folder reports the workspace already there"
        );
        assert_eq!(via_link.record.id, first.record.id);

        let variant = dir.path().join("PROJ");
        if !variant.exists() {
            // A case-sensitive volume: the two spellings really are two folders.
            return;
        }
        let via_case = service.add(variant.to_str().unwrap(), None).unwrap();
        assert!(
            !via_case.created,
            "a letter-case variant reports the workspace already there"
        );
        assert_eq!(via_case.record.id, first.record.id);
        assert_eq!(
            service.list().unwrap().len(),
            1,
            "one folder, one workspace"
        );
        let views = service
            .views(&[
                meta("session-upper", variant.to_str().unwrap()),
                meta("session-link", link.to_str().unwrap()),
            ])
            .unwrap();
        assert_eq!(views[0].session_ids, vec!["session-upper", "session-link"]);
    }

    /// A real folder and a link to it — `/tmp` and `/private/tmp` in miniature — beside a fresh record file.
    #[cfg(unix)]
    fn linked() -> (
        tempfile::TempDir,
        WorkspaceService,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let (dir, service) = service();
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let real = std::fs::canonicalize(&real).unwrap();
        (dir, service, real, alias)
    }

    /// A workspace whose folder was deleted or moved is still found, renamed and removed by its id, its stored path
    /// and a spelling through a link (#141): the lexical fallback of `canonical_path` keeps the link once the folder is
    /// gone, so that spelling named no record. DSH removes and renames by id (dsh-workspace lib/index.js:461-471).
    #[cfg(unix)]
    #[test]
    fn a_workspace_whose_folder_is_gone_is_found_by_id_stored_path_and_a_spelling_through_a_link() {
        let (_dir, service, real, alias) = linked();
        std::fs::create_dir_all(real.join("w")).unwrap();
        let typed = alias.join("w").to_string_lossy().into_owned();
        let record = service.add(&typed, None).unwrap().record;
        assert_eq!(record.path, real.join("w").to_string_lossy());
        std::fs::remove_dir_all(real.join("w")).unwrap();

        assert_eq!(
            service.find(&record.id).unwrap().map(|found| found.id),
            Some(record.id.clone())
        );
        assert_eq!(
            service.find(&record.path).unwrap().map(|found| found.id),
            Some(record.id.clone())
        );
        assert_eq!(
            service.find(&typed).unwrap().map(|found| found.id),
            Some(record.id.clone()),
            "the path a person typed, through the link, though the folder is gone"
        );
        assert!(
            service
                .find(&alias.join("never").to_string_lossy())
                .unwrap()
                .is_none(),
            "a folder that is gone and was never registered is no workspace"
        );
        let renamed = service.rename(&typed, "Gone").unwrap().unwrap();
        assert_eq!(renamed.title, "Gone");
        let removal = service.remove(&typed, &[], true).unwrap();
        assert_eq!(removal.removed.id, record.id);
        assert!(service.list().unwrap().is_empty());
    }

    /// `GET /api/workspaces` marks a folder that is gone `missing-dir`, DSH's `Workspace.status()`, and reading it
    /// writes nothing (dsh-workspace lib/index.js:154-160).
    #[cfg(unix)]
    #[test]
    fn the_views_mark_a_folder_that_is_gone_missing_dir_and_leave_the_record_as_it_was() {
        let (_dir, service, real, _alias) = linked();
        for name in ["kept", "deleted", "moved", "replaced"] {
            std::fs::create_dir_all(real.join(name)).unwrap();
        }
        let id = |name: &str| {
            service
                .add(&real.join(name).to_string_lossy(), None)
                .unwrap()
                .record
                .id
        };
        let ids: Vec<String> = ["kept", "deleted", "moved", "replaced"]
            .into_iter()
            .map(id)
            .collect();
        std::fs::remove_dir_all(real.join("deleted")).unwrap();
        std::fs::rename(real.join("moved"), real.join("..").join("moved-away")).unwrap();
        std::fs::remove_dir_all(real.join("replaced")).unwrap();
        std::fs::write(real.join("replaced"), "a file where the folder was\n").unwrap();
        let before = std::fs::read_to_string(service.file()).unwrap();
        let views = service.views(&[]).unwrap();
        let status = |id: &str| views.iter().find(|view| view.id == id).unwrap().status;
        assert_eq!(status(&ids[0]), Some(FolderStatus::Ok));
        for (index, what) in [(1, "deleted"), (2, "moved"), (3, "no longer a folder")] {
            assert_eq!(
                status(&ids[index]),
                Some(FolderStatus::MissingDir),
                "{what}"
            );
        }
        assert_eq!(
            serde_json::to_value(FolderStatus::MissingDir).unwrap(),
            "missing-dir"
        );
        assert_eq!(std::fs::read_to_string(service.file()).unwrap(), before);
        assert_eq!(
            workspace_views(&service.list().unwrap(), &[])[0].status,
            None,
            "the pure views leave the status out"
        );
    }

    /// The tree route's question (#141): a folder that is gone under a root is missing there, at its canonical path,
    /// and one behind a link out of every root is outside.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_is_gone_is_missing_under_its_root_and_outside_behind_a_link_out() {
        let (_dir, service, real, alias) = linked();
        std::fs::create_dir_all(real.join("w").join("inner")).unwrap();
        let outside = real.join("..").join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let outside = std::fs::canonicalize(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, real.join("w").join("way-out")).unwrap();
        let record = service
            .add(&real.join("w").to_string_lossy(), None)
            .unwrap()
            .record;
        let missing = |path: std::path::PathBuf| {
            service
                .missing_folder(&path.to_string_lossy())
                .unwrap()
                .map(|(at, owner)| (at, owner.map(|owner| owner.id)))
        };
        let text = |path: std::path::PathBuf| path.to_string_lossy().into_owned();
        assert_eq!(missing(real.join("w").join("inner")), None);
        assert_eq!(missing(alias.join("w")), None, "nor one through a link");
        assert_eq!(
            missing(alias.join("w").join("never-made")),
            Some((
                text(real.join("w").join("never-made")),
                Some(record.id.clone())
            ))
        );
        assert_eq!(
            missing(real.join("w").join("way-out").join("never-made")),
            Some((text(outside.join("never-made")), None)),
            "judged where the link lands"
        );
        std::fs::remove_dir_all(real.join("w")).unwrap();
        assert_eq!(
            missing(alias.join("w")),
            Some((text(real.join("w")), Some(record.id.clone()))),
            "the root's own folder, gone, is still the root's"
        );
    }

    /// A reorder says whether it moved anything, so the route announces only a real move (#136; DSH's early
    /// returns, dsh-workspace lib/index.js:484, :492).
    #[test]
    fn a_reorder_says_whether_it_moved_anything_and_writes_nothing_when_it_did_not() {
        let (_dir, service) = service();
        let one = service.add("/work/one", Some("one")).unwrap().record.id;
        let two = service.add("/work/two", Some("two")).unwrap().record.id;
        let three = service.add("/work/three", Some("three")).unwrap().record.id;
        assert_eq!(
            service.reorder(&one, Some(&three)).unwrap(),
            (vec![one.clone(), three.clone(), two.clone()], true)
        );
        let written = std::fs::read_to_string(service.file()).unwrap();
        for (id, before) in [
            (&two, Some(two.as_str())),
            (&two, None),
            (&three, Some(two.as_str())),
        ] {
            assert_eq!(
                service.reorder(id, before).unwrap(),
                (vec![one.clone(), three.clone(), two.clone()], false),
                "{id} before {before:?} moves nothing"
            );
        }
        assert_eq!(std::fs::read_to_string(service.file()).unwrap(), written);
        assert_eq!(
            service.reorder("/work/three", None).unwrap(),
            (vec![one.clone(), two.clone(), three.clone()], true)
        );
        assert!(matches!(
            service.reorder("w-nowhere", None),
            Err(WorkspaceError::OrderInvalid(_))
        ));
    }

    /// A store whose `$HEDDLE_HOME` is a temp folder, so first use makes its folder there.
    fn install() -> (tempfile::TempDir, WorkspaceService) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let env = Env::default().with("HEDDLE_HOME", home.to_string_lossy());
        let service = WorkspaceService::new(&WorkspaceConfig::default(), &env);
        (dir, service)
    }

    #[test]
    fn the_default_folder_is_heddles_home_default_workspace() {
        let env = Env::default().with("HEDDLE_HOME", "/fixture/home");
        assert_eq!(DEFAULT_WORKSPACE_DIRECTORY, "default-workspace");
        assert_eq!(
            default_workspace_directory(&env),
            "/fixture/home/default-workspace"
        );
        let service = WorkspaceService::new(&WorkspaceConfig::default(), &env);
        assert_eq!(
            service.default_directory(),
            "/fixture/home/default-workspace"
        );
        let unset = Env::default().with("HOME", "/fixture/user");
        assert_eq!(
            default_workspace_directory(&unset),
            "/fixture/user/.heddle/default-workspace",
            "heddle's own home, never the user's Documents"
        );
    }

    #[test]
    fn an_empty_install_creates_the_default_workspace_once_and_reuses_it() {
        let (_dir, service) = install();
        let created = service
            .initialize_default(&[])
            .unwrap()
            .expect("a first use");
        assert_eq!(created.path, cwd(service.default_directory()));
        assert_eq!(created.title, "default-workspace");
        assert_eq!(created.origin, WorkspaceOrigin::Added);
        assert!(Path::new(service.default_directory()).is_dir());
        assert_eq!(service.list().unwrap(), vec![created.clone()]);
        assert_eq!(
            service.read().unwrap().default_workspace_id,
            Some(created.id.clone())
        );

        let again = service.initialize_default(&[]).unwrap().expect("reused");
        assert_eq!(again.id, created.id, "the same workspace, not a second one");
        assert_eq!(service.list().unwrap().len(), 1);
    }

    #[test]
    fn a_default_folder_that_already_exists_is_reused_as_it_is() {
        let (_dir, service) = install();
        std::fs::create_dir_all(service.default_directory()).unwrap();
        let notes = Path::new(service.default_directory()).join("notes.md");
        std::fs::write(&notes, "kept\n").unwrap();
        let record = service.initialize_default(&[]).unwrap().unwrap();
        assert_eq!(record.path, cwd(service.default_directory()));
        assert_eq!(std::fs::read_to_string(&notes).unwrap(), "kept\n");
    }

    #[test]
    fn first_use_is_only_for_an_empty_install() {
        let (dir, with_workspace) = install();
        let chosen = dir.path().join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        with_workspace.add(chosen.to_str().unwrap(), None).unwrap();
        assert_eq!(with_workspace.initialize_default(&[]).unwrap(), None);
        assert!(!Path::new(with_workspace.default_directory()).exists());

        let (dir, with_session) = install();
        let elsewhere = dir.path().join("elsewhere");
        let sessions = [meta("session-1", elsewhere.to_str().unwrap())];
        assert_eq!(with_session.initialize_default(&sessions).unwrap(), None);
        assert!(!Path::new(with_session.default_directory()).exists());
        assert!(with_session.list().unwrap().is_empty());
    }

    #[test]
    fn deleting_the_default_workspace_turns_first_use_off_and_keeps_its_folder() {
        let (_dir, service) = install();
        let created = service.initialize_default(&[]).unwrap().unwrap();
        service.remove(&created.id, &[], false).unwrap();
        assert!(service.list().unwrap().is_empty());
        assert_eq!(service.initialize_default(&[]).unwrap(), None);
        assert!(service.list().unwrap().is_empty());
        assert!(Path::new(service.default_directory()).is_dir());
        assert_eq!(
            service.read().unwrap().default_workspace_id,
            Some(created.id)
        );
    }

    #[test]
    fn the_record_keeps_the_default_workspace_through_other_writes() {
        let (dir, service) = install();
        let created = service.initialize_default(&[]).unwrap().unwrap();
        let other = dir.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        service.add(other.to_str().unwrap(), None).unwrap();
        service.rename(&created.id, "Mine").unwrap();
        let text = std::fs::read_to_string(service.file()).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            vec![
                "version",
                "workspaceIds",
                "workspaces",
                "defaultWorkspaceId"
            ],
            "the TypeScript build's order"
        );
        assert_eq!(value["defaultWorkspaceId"], created.id.as_str());
    }

    // #196: a workspace list whose file cannot be read is refused, never read as no workspaces. The same cases and
    // the same words as test/workspace-registry-unreadable.test.ts.

    /// A service whose unreadable-list lines are collected rather than printed.
    fn collecting() -> (
        tempfile::TempDir,
        WorkspaceService,
        Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let (dir, service) = service();
        let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        service.set_warn(Arc::new(move |line: &str| {
            sink.lock().unwrap().push(line.to_string())
        }));
        (dir, service, lines)
    }

    /// J176's setup: four registered, one renamed, one moved.
    fn four_registered(dir: &tempfile::TempDir, service: &WorkspaceService) -> Vec<String> {
        let ids: Vec<String> = ["w1", "w2", "w3", "w4"]
            .iter()
            .map(|name| {
                let folder = dir.path().join(name);
                std::fs::create_dir_all(&folder).unwrap();
                service
                    .add(folder.to_str().unwrap(), None)
                    .unwrap()
                    .record
                    .id
            })
            .collect();
        service.rename(&ids[1], "Second (renamed)").unwrap();
        service.reorder(&ids[2], Some(&ids[0])).unwrap();
        ids
    }

    /// The reason of the error a read answers.
    fn refused(service: &WorkspaceService) -> String {
        match service.list() {
            Err(WorkspaceError::RegistryUnreadable { reason, .. }) => reason,
            other => panic!("expected the list to be unreadable, got {other:?}"),
        }
    }

    /// Every write the service offers, each of which must be refused over an unreadable file.
    fn assert_every_write_refused(dir: &tempfile::TempDir, service: &WorkspaceService, id: &str) {
        let fresh = dir.path().join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        let fresh = fresh.to_str().unwrap();
        let unreadable = |result: Result<(), WorkspaceError>| {
            matches!(result, Err(WorkspaceError::RegistryUnreadable { .. }))
        };
        assert!(unreadable(service.add(fresh, None).map(|_| ())), "add");
        assert!(
            unreadable(service.ensure_owner(fresh).map(|_| ())),
            "ensure_owner"
        );
        assert!(
            unreadable(service.rename(id, "Another title").map(|_| ())),
            "rename"
        );
        assert!(
            unreadable(service.remove(id, &[], true).map(|_| ())),
            "remove"
        );
        assert!(unreadable(service.reorder(id, None).map(|_| ())), "reorder");
        assert!(
            unreadable(service.initialize_default(&[]).map(|_| ())),
            "initialize_default"
        );
    }

    #[test]
    fn a_missing_file_is_the_empty_list_of_a_fresh_home_and_says_nothing() {
        let (dir, service, lines) = collecting();
        assert_eq!(service.list().unwrap(), Vec::new());
        assert!(service.views(&[]).unwrap().is_empty());
        service.check().unwrap();
        let folder = dir.path().join("first");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(service.add(folder.to_str().unwrap(), None).unwrap().created);
        assert!(
            lines.lock().unwrap().is_empty(),
            "a fresh home is not a damage"
        );
    }

    #[test]
    fn a_trailing_comma_refuses_every_read_and_every_write_and_the_file_is_untouched() {
        let (dir, service, lines) = collecting();
        let ids = four_registered(&dir, &service);
        let good = std::fs::read_to_string(service.file()).unwrap();
        let damaged = good.replacen("\"version\": 3,", "\"version\": 3,,", 1);
        assert_ne!(damaged, good);
        std::fs::write(service.file(), &damaged).unwrap();
        let modified = std::fs::metadata(service.file())
            .unwrap()
            .modified()
            .unwrap();

        let error = service.list().unwrap_err();
        assert_eq!(
            error.to_string(),
            "the workspace list could not be read: workspaces.json: not valid JSON"
        );
        assert_eq!(error.code(), Some("workspace/registry-unreadable"));
        assert!(matches!(
            service.views(&[]),
            Err(WorkspaceError::RegistryUnreadable { .. })
        ));
        assert!(matches!(
            service.find(&ids[0]),
            Err(WorkspaceError::RegistryUnreadable { .. })
        ));
        assert!(matches!(
            service.owner("/anywhere"),
            Err(WorkspaceError::RegistryUnreadable { .. })
        ));
        assert!(service.check().is_err());
        assert_every_write_refused(&dir, &service, &ids[0]);
        let report = service
            .bootstrap(&[
                meta("session-1", dir.path().join("w1").to_str().unwrap()),
                meta("session-2", dir.path().join("elsewhere").to_str().unwrap()),
            ])
            .unwrap();
        assert!(
            report.skipped,
            "the start rebuilds nothing from the sessions"
        );
        assert_eq!(std::fs::read_to_string(service.file()).unwrap(), damaged);
        assert_eq!(
            std::fs::metadata(service.file())
                .unwrap()
                .modified()
                .unwrap(),
            modified,
            "and was not written at all"
        );
        let lines_now = lines.lock().unwrap().clone();
        assert_eq!(
            lines_now.len(),
            1,
            "one line, however often it is read: {lines_now:?}"
        );
        assert!(
            lines_now[0].starts_with(&format!(
                "heddle workspace: unreadable workspace list {}: not valid JSON (",
                service.file()
            )),
            "{}",
            lines_now[0]
        );
        assert!(
            lines_now[0].contains("line 2 column 16"),
            "the parser says where: {}",
            lines_now[0]
        );
        assert!(lines_now[0].ends_with(
            "; it is left as it is, and every workspace change is refused until it reads"
        ));

        std::fs::write(service.file(), &good).unwrap();
        let order: Vec<String> = service
            .list()
            .unwrap()
            .into_iter()
            .map(|record| record.id)
            .collect();
        assert_eq!(
            order,
            vec![
                ids[3].clone(),
                ids[1].clone(),
                ids[2].clone(),
                ids[0].clone()
            ],
            "the comma fixed, all four are back in their order"
        );
        assert_eq!(
            service.find(&ids[1]).unwrap().unwrap().title,
            "Second (renamed)"
        );
        std::fs::write(service.file(), "").unwrap();
        assert_eq!(refused(&service), "the file is empty");
        assert_eq!(
            lines.lock().unwrap().len(),
            2,
            "a damage after a good read is named again"
        );
    }

    #[test]
    fn an_empty_file_is_refused_and_the_start_writes_nothing_over_it() {
        for text in ["", " \n\t\n"] {
            let (dir, service, lines) = collecting();
            std::fs::write(service.file(), text).unwrap();
            assert_eq!(refused(&service), "the file is empty");
            let report = service
                .bootstrap(&[
                    meta("session-1", dir.path().join("w1").to_str().unwrap()),
                    meta("session-2", dir.path().join("w2").to_str().unwrap()),
                ])
                .unwrap();
            assert_eq!(
                report,
                BootstrapReport {
                    workspaces: 0,
                    attached: 0,
                    created: 0,
                    skipped: true
                }
            );
            assert_eq!(
                serde_json::to_value(report).unwrap(),
                json!({"workspaces": 0, "attached": 0, "created": 0, "skipped": true})
            );
            assert_every_write_refused(&dir, &service, "w-1");
            assert_eq!(std::fs::read_to_string(service.file()).unwrap(), text);
            assert_eq!(
                lines.lock().unwrap().clone(),
                vec![unreadable_registry_line(
                    service.file(),
                    "the file is empty",
                    None
                )]
            );
        }
    }

    #[test]
    fn each_kind_of_damage_has_one_reason_the_typescript_builds_words() {
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("an empty file", b"".to_vec(), "the file is empty"),
            ("whitespace", b"  \n".to_vec(), "the file is empty"),
            (
                "a doubled comma",
                b"{\n  \"version\": 3,,\n  \"workspaceIds\": []\n}\n".to_vec(),
                "not valid JSON",
            ),
            (
                "a trailing comma",
                b"{\n  \"version\": 3,\n  \"workspaceIds\": [],\n}\n".to_vec(),
                "not valid JSON",
            ),
            (
                "a cut file",
                b"{\n  \"version\": 3,\n  \"workspaceIds\": [\n    \"w-1\"".to_vec(),
                "not valid JSON",
            ),
            ("text after the JSON", b"{}\nx".to_vec(), "not valid JSON"),
            ("a word", b"workspaces".to_vec(), "not valid JSON"),
            (
                "an array",
                b"[]".to_vec(),
                "not a workspace list: it is not a JSON object",
            ),
            (
                "null",
                b"null".to_vec(),
                "not a workspace list: it is not a JSON object",
            ),
            (
                "ids that are not a list",
                b"{\"workspaceIds\": \"w-1\"}".to_vec(),
                "not a workspace list: \"workspaceIds\" is not a list of ids",
            ),
            (
                "an id that is not a string",
                b"{\"workspaceIds\": [1]}".to_vec(),
                "not a workspace list: \"workspaceIds\" is not a list of ids",
            ),
            (
                "records that are not an object",
                b"{\"workspaces\": []}".to_vec(),
                "not a workspace list: \"workspaces\" is not an object",
            ),
            (
                "a record without a title",
                b"{\"workspaceIds\": [\"w-1\"], \"workspaces\": {\"w-1\": {\"path\": \"/a\"}}}"
                    .to_vec(),
                "not a workspace list: workspace \"w-1\" needs a path and a title",
            ),
            (
                "a record that is not an object",
                b"{\"workspaces\": {\"w-1\": \"/a\"}}".to_vec(),
                "not a workspace list: workspace \"w-1\" needs a path and a title",
            ),
            (
                "bytes that are not UTF-8",
                vec![0x7b, 0xff, 0xfe, 0x7d],
                "not UTF-8 text",
            ),
            (
                "a byte-order mark before the JSON",
                vec![0xef, 0xbb, 0xbf, 0x7b, 0x7d],
                "not valid JSON",
            ),
        ];
        for (what, bytes, reason) in cases {
            let (_dir, service, _lines) = collecting();
            std::fs::write(service.file(), bytes).unwrap();
            assert_eq!(refused(&service), reason, "{what}");
        }
    }

    #[test]
    fn what_a_version_one_or_hand_made_file_may_leave_out_still_reads() {
        for text in [
            "{}",
            "{\"version\": 3}",
            "{\"workspaceIds\": []}",
            "{\"workspaces\": {}}",
            "{\"version\":1,\"workspaceIds\":[\"w-1\"],\"workspaces\":{\"w-1\":{\"path\":\"/work/one\",\"title\":\"one\",\"sessionIds\":[\"s\"]}}}",
        ] {
            let (_dir, service, lines) = collecting();
            std::fs::write(service.file(), text).unwrap();
            assert!(service.list().is_ok(), "{text}");
            assert!(lines.lock().unwrap().is_empty(), "{text}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_file_the_server_may_not_read_or_a_folder_in_its_place_is_refused_without_a_path() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, as_folder, _lines) = collecting();
        std::fs::create_dir_all(as_folder.file()).unwrap();
        assert_eq!(refused(&as_folder), "it is a folder, not a file");
        assert_every_write_refused(&dir, &as_folder, "w-1");
        assert!(
            Path::new(as_folder.file()).is_dir(),
            "the folder is still a folder"
        );

        let (dir, denied, _lines) = collecting();
        four_registered(&dir, &denied);
        let good = std::fs::read(denied.file()).unwrap();
        std::fs::set_permissions(denied.file(), std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(denied.file()).is_ok() {
            std::fs::set_permissions(denied.file(), std::fs::Permissions::from_mode(0o600))
                .unwrap();
            eprintln!("unjudged: this host reads mode 000 (root)");
            return;
        }
        assert_eq!(refused(&denied), "permission denied");
        let message = denied.list().unwrap_err().to_string();
        assert_eq!(
            message,
            "the workspace list could not be read: workspaces.json: permission denied"
        );
        assert!(
            !message.contains(dir.path().to_str().unwrap()),
            "the file's name, never its folder"
        );
        // A rename would replace a file this process may not read (J176b): every write is refused instead.
        assert_every_write_refused(&dir, &denied, "w-1");
        std::fs::set_permissions(denied.file(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            std::fs::read(denied.file()).unwrap(),
            good,
            "byte for byte what it was"
        );
        assert_eq!(denied.list().unwrap().len(), 4);
    }

    #[cfg(unix)]
    #[test]
    fn a_write_replaces_the_file_whole_and_a_write_that_fails_leaves_the_old_file() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let (dir, service, _lines) = collecting();
        for name in ["one", "two", "three"] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        service
            .add(dir.path().join("one").to_str().unwrap(), None)
            .unwrap();
        let first = std::fs::metadata(service.file()).unwrap().ino();
        service
            .add(dir.path().join("two").to_str().unwrap(), None)
            .unwrap();
        assert_ne!(
            std::fs::metadata(service.file()).unwrap().ino(),
            first,
            "a new file renamed over the old one"
        );
        let leftovers = || {
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.ends_with(".tmp"))
                .collect::<Vec<_>>()
        };
        assert!(leftovers().is_empty(), "and nothing is left beside it");

        let kept = std::fs::read(service.file()).unwrap();
        let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let probe = std::fs::write(dir.path().join("probe"), "");
        let failed = service.add(dir.path().join("three").to_str().unwrap(), None);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(mode)).unwrap();
        if probe.is_ok() {
            eprintln!("unjudged: this host writes into a read-only folder (root)");
            return;
        }
        assert!(
            matches!(failed, Err(WorkspaceError::Io { .. })),
            "{failed:?}"
        );
        assert_eq!(
            std::fs::read(service.file()).unwrap(),
            kept,
            "the old list, whole"
        );
        assert!(leftovers().is_empty(), "and no temporary file");
        assert_eq!(service.list().unwrap().len(), 2);
    }
}
