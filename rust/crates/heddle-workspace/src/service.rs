//! The workspace service: the record file, read fresh on every call, reconciled with the sessions.
//!
//! Ported from `WorkspaceService` and `WorkspacePlugin` in `src/workspace/service.ts`. The TypeScript
//! plugin bootstraps from `ctx.session.list()` on every load; the Rust boot does the same by calling
//! [`WorkspaceService::bootstrap`] with the session list right after constructing the service.
//!
//! The file is read on every call rather than cached, as the TypeScript build does; an internal lock
//! serializes this process's read-modify-write cycles so two HTTP requests cannot lose each other's edit.

use std::path::Path;

use heddle_config::{Env, canonical_path, depth_of, expand_home, heddle_home, is_under};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use heddle_session::SessionMeta;

use crate::error::WorkspaceError;
use crate::record::{
    BootstrapReport, WorkspaceAddition, WorkspaceOrigin, WorkspaceRecord, WorkspaceRemoval,
    WorkspaceStoreShape, WorkspaceView,
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

/// The workspace service.
#[derive(Debug)]
pub struct WorkspaceService {
    file: String,
    generated: Vec<String>,
    lock: std::sync::Mutex<()>,
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
            lock: std::sync::Mutex::new(()),
        }
    }

    /// The record file's absolute path.
    pub fn file(&self) -> &str {
        &self.file
    }

    /// The configured generated-folder names.
    pub fn generated(&self) -> &[String] {
        &self.generated
    }

    /// The whole record, read from disk. A missing or unreadable file is an empty record; an entry
    /// without a string `path` and `title` is skipped; a missing `origin` reads `added`, a missing time
    /// the epoch.
    pub fn read(&self) -> WorkspaceStoreShape {
        let Ok(text) = std::fs::read_to_string(&self.file) else {
            return WorkspaceStoreShape::default();
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return WorkspaceStoreShape::default();
        };
        let workspace_ids: Vec<String> = value
            .get("workspaceIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let mut workspaces = IndexMap::new();
        if let Some(Value::Object(records)) = value.get("workspaces") {
            for (key, record) in records {
                let Value::Object(record) = record else {
                    continue;
                };
                let (Some(path), Some(title)) = (
                    record.get("path").and_then(Value::as_str),
                    record.get("title").and_then(Value::as_str),
                ) else {
                    continue;
                };
                // Rebuilt field by field, so a version-1 file's `sessionIds` is dropped on the way in as
                // well as on the way out.
                let id = record
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(key)
                    .to_string();
                let origin = if record.get("origin").and_then(Value::as_str) == Some("auto") {
                    WorkspaceOrigin::Auto
                } else {
                    WorkspaceOrigin::Added
                };
                let time = |key: &str| {
                    record
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or(EPOCH_ISO)
                        .to_string()
                };
                workspaces.insert(
                    key.clone(),
                    WorkspaceRecord {
                        id,
                        path: path.to_string(),
                        title: title.to_string(),
                        origin,
                        created_at: time("createdAt"),
                        updated_at: time("updatedAt"),
                    },
                );
            }
        }
        WorkspaceStoreShape {
            version: 3,
            workspace_ids,
            workspaces,
        }
    }

    /// Write the record, creating its directory.
    fn write(&self, shape: &WorkspaceStoreShape) -> Result<(), WorkspaceError> {
        if let Some(parent) = Path::new(&self.file).parent() {
            std::fs::create_dir_all(parent).map_err(|error| WorkspaceError::Io {
                path: parent.to_string_lossy().into_owned(),
                source: error,
            })?;
        }
        heddle_session::write_atomic(&self.file, shape.to_file_text()).map_err(|error| {
            WorkspaceError::Io {
                path: self.file.clone(),
                source: error,
            }
        })
    }

    /// Every workspace in `workspaceIds` order.
    pub fn list(&self) -> Vec<WorkspaceRecord> {
        let shape = self.read();
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
        let mut shape = self.read();
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
        let before = self.find(path);
        let record = self.ensure(path, title, Some(WorkspaceOrigin::Added))?;
        Ok(WorkspaceAddition {
            record,
            created: before.is_none(),
        })
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
        let mut shape = self.read();
        let record = self
            .find(id_or_path)
            .ok_or_else(|| WorkspaceError::NotFound(id_or_path.to_string()))?;
        let owned = self.sessions(&record, all);
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
    pub fn find(&self, id_or_path: &str) -> Option<WorkspaceRecord> {
        let shape = self.read();
        if let Some(record) = shape.workspaces.get(id_or_path) {
            return Some(record.clone());
        }
        let canonical = canonical_path(Path::new(id_or_path))
            .to_string_lossy()
            .into_owned();
        shape
            .workspaces
            .values()
            .find(|record| record.path == canonical)
            .cloned()
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
        let Some(record) = self.find(id_or_path) else {
            return Ok(None);
        };
        let mut shape = self.read();
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

    /// The root that owns a folder: the **nearest** registered root at or above it.
    pub fn owner(&self, path: &str) -> Option<WorkspaceRecord> {
        Self::owner_among(path, &self.list())
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
    pub fn sessions(&self, record: &WorkspaceRecord, all: &[SessionMeta]) -> Vec<SessionMeta> {
        let records = self.list();
        all.iter()
            .filter(|meta| {
                let canonical = canonical_path(Path::new(meta.cwd()));
                if !is_under(Path::new(&record.path), &canonical) {
                    return false;
                }
                Self::owner_among(&canonical.to_string_lossy(), &records)
                    .map(|owner| owner.id == record.id)
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    /// Every workspace with its parent and its sessions — what `GET /api/workspaces` answers. See
    /// [`workspace_views`].
    pub fn views(&self, all: &[SessionMeta]) -> Vec<WorkspaceView> {
        workspace_views(&self.list(), all)
    }

    /// The root that owns a folder, adopting the folder itself (`auto`) when nothing above it does.
    pub fn ensure_owner(&self, path: &str) -> Result<WorkspaceRecord, WorkspaceError> {
        let canonical = canonical_path(Path::new(path))
            .to_string_lossy()
            .into_owned();
        match self.owner(&canonical) {
            Some(record) => Ok(record),
            None => self.ensure(&canonical, None, Some(WorkspaceOrigin::Auto)),
        }
    }

    /// Group every session under the nearest root above it, adopting a root where there is none.
    /// Idempotent.
    pub fn bootstrap(&self, all: &[SessionMeta]) -> Result<BootstrapReport, WorkspaceError> {
        let mut attached = 0usize;
        let mut created = 0usize;
        for meta in all {
            let canonical = canonical_path(Path::new(meta.cwd()))
                .to_string_lossy()
                .into_owned();
            if self.owner(&canonical).is_none() {
                self.ensure(&canonical, None, Some(WorkspaceOrigin::Auto))?;
                created += 1;
            }
            attached += 1;
        }
        Ok(BootstrapReport {
            workspaces: self.list().len(),
            attached,
            created,
        })
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
        assert_eq!(service.read(), WorkspaceStoreShape::default());
        assert!(service.list().is_empty());
        assert_eq!(service.find("/nowhere"), None);
    }

    #[test]
    fn a_version_one_file_loses_its_session_ids_and_gains_the_missing_defaults() {
        let (dir, service) = service();
        std::fs::write(
            service.file(),
            "{\n  \"version\": 1,\n  \"workspaceIds\": [\"w-1\"],\n  \"workspaces\": {\n    \"w-1\": {\n      \"path\": \"/work/one\",\n      \"title\": \"one\",\n      \"sessionIds\": [\"session-1\"]\n    }\n  }\n}\n",
        )
        .unwrap();
        let shape = service.read();
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
        let listed = service.list();
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
        assert_eq!(service.list().len(), 3);
        let promoted = service.add("/work/three", Some("three")).unwrap();
        assert!(!promoted.created, "the record already existed");
        assert_eq!(promoted.record.id, adopted.id);
        assert_eq!(promoted.record.origin, WorkspaceOrigin::Added);
        assert_eq!(service.list().len(), 3);
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
            service.owner(deep.to_str().unwrap()).unwrap().id,
            inner_record.id,
            "the nearest root owns a session"
        );
        assert_eq!(service.sessions(&inner_record, &sessions).len(), 1);
        let outer = service.find(root.to_str().unwrap()).unwrap();
        assert_eq!(
            service.sessions(&outer, &sessions).len(),
            0,
            "the outer root does not claim it as well"
        );

        // A sibling whose path shares every character of the root is not inside it.
        let sibling_sessions = vec![meta("session-2", sibling.to_str().unwrap())];
        assert_eq!(service.sessions(&outer, &sibling_sessions).len(), 0);
        assert_eq!(
            service.sessions(&sibling_record, &sibling_sessions).len(),
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
        assert!(service.list().is_empty());
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
        assert_eq!(service.list().len(), 1);
        assert_eq!(
            service.owner(inner.to_str().unwrap()).unwrap().title,
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
        let views = service.views(&all);
        let ids: Vec<String> = views.iter().map(|view| view.id.clone()).collect();
        let listed: Vec<String> = service.list().into_iter().map(|record| record.id).collect();
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
                "sessionIds"
            ],
            "the TypeScript route's keys, in its order"
        );
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
        assert_eq!(service.list().len(), 1, "one folder, one workspace");
        let views = service.views(&[
            meta("session-upper", variant.to_str().unwrap()),
            meta("session-link", link.to_str().unwrap()),
        ]);
        assert_eq!(views[0].session_ids, vec!["session-upper", "session-link"]);
    }
}
