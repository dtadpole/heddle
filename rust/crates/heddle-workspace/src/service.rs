//! The workspace service: the record file, read fresh on every call, reconciled with the sessions.
//!
//! Ported from `WorkspaceService` and `WorkspacePlugin` in `src/workspace/service.ts`. The TypeScript
//! plugin bootstraps from `ctx.session.list()` on every load; the Rust boot does the same by calling
//! [`WorkspaceService::bootstrap`] with the session list right after constructing the service.
//!
//! The file is read on every call rather than cached, as the TypeScript build does; an internal lock
//! serializes this process's read-modify-write cycles so two HTTP requests cannot lose each other's edit.

use heddle_config::Env;
use serde::Deserialize;

use heddle_session::SessionMeta;

use crate::error::WorkspaceError;
use crate::record::{
    BootstrapReport, WorkspaceAddition, WorkspaceOrigin, WorkspaceRecord, WorkspaceRemoval,
    WorkspaceStoreShape,
};

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
    todo!()
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
        todo!()
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
        todo!()
    }

    /// Every workspace in `workspaceIds` order.
    pub fn list(&self) -> Vec<WorkspaceRecord> {
        todo!()
    }

    /// The record for a path, creating it when there is none (title: the last path segment). An
    /// existing `auto` record asked for as `added` is promoted. A new record is prepended to the order.
    pub fn ensure(
        &self,
        path: &str,
        title: Option<&str>,
        origin: Option<WorkspaceOrigin>,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        todo!()
    }

    /// Register a target folder (`added`), reporting whether this call created the record.
    pub fn add(
        &self,
        path: &str,
        title: Option<&str>,
    ) -> Result<WorkspaceAddition, WorkspaceError> {
        todo!()
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
        todo!()
    }

    /// One workspace by id, else by canonical path.
    pub fn find(&self, id_or_path: &str) -> Option<WorkspaceRecord> {
        todo!()
    }

    /// Retitle a root by id or path; the path never changes. `Ok(None)` for an unknown root,
    /// [`WorkspaceError::EmptyName`] for a blank title.
    pub fn rename(
        &self,
        id_or_path: &str,
        title: &str,
    ) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
        todo!()
    }

    /// The root that owns a folder: the **nearest** registered root at or above it.
    pub fn owner(&self, path: &str) -> Option<WorkspaceRecord> {
        todo!()
    }

    /// The nearest of `records` at or above `path` — [`WorkspaceService::owner`] over a given set.
    pub fn owner_among(path: &str, records: &[WorkspaceRecord]) -> Option<WorkspaceRecord> {
        todo!()
    }

    /// The sessions a root accounts for: bound at or below it, minus those a nearer root owns, in the
    /// order given (the store's newest first).
    pub fn sessions(&self, record: &WorkspaceRecord, all: &[SessionMeta]) -> Vec<SessionMeta> {
        todo!()
    }

    /// The root that owns a folder, adopting the folder itself (`auto`) when nothing above it does.
    pub fn ensure_owner(&self, path: &str) -> Result<WorkspaceRecord, WorkspaceError> {
        todo!()
    }

    /// Group every session under the nearest root above it, adopting a root where there is none.
    /// Idempotent.
    pub fn bootstrap(&self, all: &[SessionMeta]) -> Result<BootstrapReport, WorkspaceError> {
        todo!()
    }
}
