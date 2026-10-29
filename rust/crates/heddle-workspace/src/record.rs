//! The workspace record file and what the service answers with.
//!
//! Ported from the types of `src/workspace/service.ts`. The file is
//! `JSON.stringify({ ...shape, version: 3 }, null, 2)` plus a newline: `version`, `workspaceIds`,
//! `workspaces` (an object keyed by id, in insertion order), each record
//! `{ id, path, title, origin, createdAt, updatedAt }` — rebuilt field by field on read, so a version-1
//! file's `sessionIds` is dropped on the way in and the way out.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
    #[serde(default)]
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

impl WorkspaceStoreShape {
    /// The bytes of the record file: `JSON.stringify({ ...shape, version: 3 }, null, 2)` plus a newline.
    pub fn to_file_text(&self) -> String {
        let mut text = serde_json::to_string_pretty(self).expect("a record file is serializable");
        text.push('\n');
        text
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

/// One workspace as the Web UI's workspace tree reads it — `GET /api/workspaces`, DSH's `WorkspaceView`
/// under heddle's rules (`workspaceViews` in `src/workspace/service.ts`). `parent` is the nearest
/// registered root strictly above (`null` at the top), `session_ids` the sessions whose nearest root this
/// is, in the store's order. Derived on every call, never stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub id: String,
    pub path: String,
    pub title: String,
    pub origin: WorkspaceOrigin,
    pub parent: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub session_ids: Vec<String>,
}

/// A record with the ids of the sessions it accounts for — one row of `heddle workspaces --json`.
pub fn listing_row(record: &WorkspaceRecord, sessions: &[SessionMeta]) -> Value {
    // `{ ...record, sessions: [ids] }`: the record's own keys in their order, then the ids.
    let Value::Object(mut object) =
        serde_json::to_value(record).expect("a workspace record is serializable")
    else {
        unreachable!("a struct serializes to an object");
    };
    let ids: Vec<Value> = sessions
        .iter()
        .map(|meta| Value::String(meta.id().to_string()))
        .collect();
    object.insert("sessions".to_string(), Value::Array(ids));
    Value::Object(object)
}

/// A version-1 file may still carry `sessionIds`; it is not read, and so never written back.
#[allow(dead_code)]
fn _ignore_session_ids(_: &Map<String, Value>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> WorkspaceRecord {
        WorkspaceRecord {
            id: "w-1".to_string(),
            path: "/work/one".to_string(),
            title: "one".to_string(),
            origin: WorkspaceOrigin::Added,
            created_at: "2026-10-22T18:17:41.123Z".to_string(),
            updated_at: "2026-10-22T18:17:41.123Z".to_string(),
        }
    }

    #[test]
    fn the_file_is_written_whole_and_ends_with_a_newline() {
        let shape = WorkspaceStoreShape {
            workspace_ids: vec!["w-1".to_string()],
            workspaces: IndexMap::from([("w-1".to_string(), record())]),
            ..Default::default()
        };
        assert_eq!(
            shape.to_file_text(),
            "{\n  \"version\": 3,\n  \"workspaceIds\": [\n    \"w-1\"\n  ],\n  \"workspaces\": {\n    \"w-1\": {\n      \"id\": \"w-1\",\n      \"path\": \"/work/one\",\n      \"title\": \"one\",\n      \"origin\": \"added\",\n      \"createdAt\": \"2026-10-22T18:17:41.123Z\",\n      \"updatedAt\": \"2026-10-22T18:17:41.123Z\"\n    }\n  }\n}\n"
        );
    }

    #[test]
    fn a_listing_row_is_the_record_then_its_session_ids() {
        let empty = listing_row(&record(), &[]);
        assert_eq!(
            empty,
            serde_json::json!({
                "id": "w-1",
                "path": "/work/one",
                "title": "one",
                "origin": "added",
                "createdAt": "2026-10-22T18:17:41.123Z",
                "updatedAt": "2026-10-22T18:17:41.123Z",
                "sessions": [],
            })
        );
        assert_eq!(
            empty.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec![
                "id",
                "path",
                "title",
                "origin",
                "createdAt",
                "updatedAt",
                "sessions"
            ],
            "the sessions key is appended, as the spread does"
        );
    }

    #[test]
    fn a_missing_origin_reads_as_added() {
        let value: Value = serde_json::from_str(
            r#"{"id":"w","path":"/x","title":"x","createdAt":"t","updatedAt":"t"}"#,
        )
        .unwrap();
        let record: WorkspaceRecord = serde_json::from_value(value).unwrap();
        assert_eq!(record.origin, WorkspaceOrigin::Added);
    }
}
