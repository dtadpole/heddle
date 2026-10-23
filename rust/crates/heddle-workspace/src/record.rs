//! The workspace record file and what the service answers with.
//!
//! Ported from the types of `src/workspace/service.ts`. The file is
//! `JSON.stringify({ ...shape, version: 3 }, null, 2)` plus a newline: `version`, `workspaceIds`,
//! `workspaces` (an object keyed by id, in insertion order), each record
//! `{ id, path, title, origin, createdAt, updatedAt }` — rebuilt field by field on read, so a version-1
//! file's `sessionIds` is dropped on the way in and the way out.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use heddle_session::SessionMeta;

/// How a root came to exist.
///
/// `added`: a person registered it (`workspace add`, the page's `+`, or promoting an adopted one).
/// `auto`: a session was found in it and `bootstrap`/`ensure_owner` adopted it. A record without the
/// field reads as `added`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceOrigin {
    #[default]
    Added,
    Auto,
}

/// One workspace: a target folder, and the record that says it is one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    /// Canonical absolute path of the target folder: the root, and the association key.
    pub path: String,
    pub title: String,
    pub origin: WorkspaceOrigin,
    pub created_at: String,
    pub updated_at: String,
}

/// The whole record file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStoreShape {
    /// Always written as 3.
    pub version: u64,
    /// Workspace ids in the collection's own order — newest registration first.
    pub workspace_ids: Vec<String>,
    pub workspaces: IndexMap<String, WorkspaceRecord>,
}

impl Default for WorkspaceStoreShape {
    fn default() -> Self {
        WorkspaceStoreShape {
            version: 3,
            workspace_ids: Vec::new(),
            workspaces: IndexMap::new(),
        }
    }
}

/// What `add` reports: the record, and whether this call created it. Serialized `{ record, created }`,
/// which is the HTTP route's body; the command line flattens it into `{ ...record, created }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceAddition {
    pub record: WorkspaceRecord,
    pub created: bool,
}

/// What `remove` reports: the record removed, how many sessions it accounted for, and the title of the
/// root above it that adopts them, when there is one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRemoval {
    pub removed: WorkspaceRecord,
    pub owned_sessions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adopted_by: Option<String>,
}

/// What `bootstrap` did: how many workspaces there are now, how many sessions it looked at, and how
/// many roots it had to create.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BootstrapReport {
    pub workspaces: usize,
    pub attached: usize,
    pub created: usize,
}

/// A record with the ids of the sessions it accounts for — one row of `heddle workspaces --json`.
pub fn listing_row(record: &WorkspaceRecord, sessions: &[SessionMeta]) -> serde_json::Value {
    todo!("{{ ...record, sessions: [ids] }}")
}
