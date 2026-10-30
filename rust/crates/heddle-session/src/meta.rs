//! One session's metadata record, and the options that create or change it.
//!
//! Ported from `SessionMeta` and the meta-writing methods of `src/session/store.ts`.
//!
//! # Why the record keeps its own JSON
//!
//! The TypeScript store edits the record by spreading it — `{ ...current, title }` — and deletes a flag
//! that became false. So an edit keeps every key it did not touch **where it was**, appends a key that is
//! new, and carries keys it does not know about. A struct would reorder the file and drop unknown keys
//! on the first rename. [`SessionMeta`] therefore *is* the ordered JSON object, with typed getters; the
//! store's edits are made on that object the way the TypeScript spreads are, and it serializes back to
//! exactly that object.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::event::SessionId;

/// One session's metadata, written once at creation and corrected rarely.
///
/// Fields, as the TypeScript build declares them: `id`, `created`, `updated?`, `cwd`, `endpoint?`,
/// `model?`, `reasoningEffort?`, `title?`, `turns`, `pinned?`, `pinnedAt?`, `archived?`,
/// `parentSession?`, `origin?`, `delegationDepth?`, `teamId?`.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionMeta {
    raw: Map<String, Value>,
}

impl SessionMeta {
    /// Accept a parsed record. `None` unless it is an object whose `id` is a string, which is the one
    /// test the session list applies before it believes a file is metadata.
    pub fn from_value(value: Value) -> Option<SessionMeta> {
        let Value::Object(raw) = value else {
            return None;
        };
        raw.get("id")?.as_str()?;
        Some(SessionMeta { raw })
    }

    /// The record as an ordered JSON object.
    pub fn as_map(&self) -> &Map<String, Value> {
        &self.raw
    }

    /// The record as one JSON value.
    pub fn to_value(&self) -> Value {
        Value::Object(self.raw.clone())
    }

    /// `JSON.stringify(meta, null, 2)` plus a newline — the bytes of a meta file.
    pub fn to_file_text(&self) -> String {
        let mut text = serde_json::to_string_pretty(&Value::Object(self.raw.clone()))
            .expect("a meta record is always serializable");
        text.push('\n');
        text
    }

    /// Set one key, keeping an existing key where it was and appending a new one — the TypeScript
    /// spread's behaviour, which is what the store's edits are made of.
    pub fn set(&mut self, key: &str, value: Value) {
        self.raw.insert(key.to_string(), value);
    }

    /// Delete one key, wherever it was.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.raw.shift_remove(key)
    }

    fn string(&self, key: &str) -> Option<&str> {
        self.raw.get(key)?.as_str()
    }

    pub fn id(&self) -> &str {
        self.string("id").unwrap_or("")
    }
    /// When it was created; `""` when the record has none.
    pub fn created(&self) -> &str {
        self.string("created").unwrap_or("")
    }
    /// When a person last prompted or steered it — the age a row shows and what Last updated sorts by.
    pub fn updated(&self) -> Option<&str> {
        self.string("updated")
    }
    /// The folder the session is bound to; `""` when a legacy record has none.
    pub fn cwd(&self) -> &str {
        self.string("cwd").unwrap_or("")
    }
    pub fn endpoint(&self) -> Option<&str> {
        self.string("endpoint")
    }
    pub fn model(&self) -> Option<&str> {
        self.string("model")
    }
    pub fn reasoning_effort(&self) -> Option<&str> {
        self.string("reasoningEffort")
    }
    pub fn title(&self) -> Option<&str> {
        self.string("title")
    }
    /// User turns recorded; 0 when absent.
    pub fn turns(&self) -> u64 {
        self.raw.get("turns").and_then(Value::as_u64).unwrap_or(0)
    }
    pub fn pinned(&self) -> bool {
        matches!(self.raw.get("pinned"), Some(Value::Bool(true)))
    }
    pub fn pinned_at(&self) -> Option<&str> {
        self.string("pinnedAt")
    }
    pub fn archived(&self) -> bool {
        matches!(self.raw.get("archived"), Some(Value::Bool(true)))
    }
    /// The session that delegated this one, when this is a subagent's.
    pub fn parent_session(&self) -> Option<&str> {
        self.string("parentSession")
    }
    pub fn origin(&self) -> Option<SessionOrigin> {
        let value = self.raw.get("origin")?.clone();
        serde_json::from_value(value).ok()
    }
    pub fn delegation_depth(&self) -> Option<u64> {
        self.raw.get("delegationDepth").and_then(Value::as_u64)
    }
    /// The Lead's session id, when this session is a teammate's.
    pub fn team_id(&self) -> Option<&str> {
        self.string("teamId")
    }
}

impl Serialize for SessionMeta {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.raw.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SessionMeta {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Map::<String, Value>::deserialize(deserializer)?;
        Ok(SessionMeta { raw })
    }
}

/// Where a delegated session came from. Only one origin exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionOrigin {
    Subagent,
}

/// What `SessionStore::create` is told. Every field is optional; an absent one is not written.
///
/// The record is written in this order — `id`, `created`, `cwd`, `endpoint`, `model`,
/// `reasoningEffort`, `title`, `parentSession`, `origin`, `delegationDepth`, `teamId`, `turns` — which is
/// the TypeScript build's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateOptions {
    /// The folder the session is bound to; the process's working directory when `None`.
    pub cwd: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub title: Option<String>,
    pub parent_session: Option<SessionId>,
    pub origin: Option<SessionOrigin>,
    pub delegation_depth: Option<u64>,
    pub team_id: Option<SessionId>,
    /// An id chosen by the caller, so a journal entry can name a session before it exists.
    /// `session-<uuid v4>` when `None`.
    pub id: Option<SessionId>,
}

/// Who a fork belongs to, beyond what it copies from its source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForkAttribution {
    pub parent_session: Option<SessionId>,
    pub origin: Option<SessionOrigin>,
    pub delegation_depth: Option<u64>,
    pub team_id: Option<SessionId>,
    pub title: Option<String>,
    pub id: Option<SessionId>,
}

/// The model switcher's one write: an endpoint, and optionally a model and a reasoning level on it.
///
/// The selection **replaces** the previous one: a `model` or `reasoning_effort` left `None` (or blank)
/// is deleted from the record, because it belonged to the endpoint that answered with it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelSelection {
    pub endpoint: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// Set or clear a session's flags in one write. `None` leaves a flag as it is.
///
/// Pinning records `pinnedAt`; unpinning deletes both. Archiving drops the pin in the same write.
/// Pinning an archived session is refused with [`crate::SessionFlagError::Archived`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FlagPatch {
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(text: &str) -> SessionMeta {
        SessionMeta::from_value(serde_json::from_str(text).unwrap()).unwrap()
    }

    #[test]
    fn a_record_needs_a_string_id() {
        assert!(SessionMeta::from_value(json!({"id": "session-1"})).is_some());
        assert!(SessionMeta::from_value(json!({"id": 7})).is_none());
        assert!(SessionMeta::from_value(json!({"created": "x"})).is_none());
        assert!(SessionMeta::from_value(json!([])).is_none());
    }

    #[test]
    fn the_typed_getters_read_what_the_record_says() {
        let record = meta(
            r#"{"id":"session-1","created":"2026-10-22T18:17:41.123Z","cwd":"/x","endpoint":"e","model":"m","reasoningEffort":"high","title":"T","turns":3,"pinned":true,"pinnedAt":"2026-10-22T18:18:00.000Z","archived":false,"parentSession":"session-0","origin":"subagent","delegationDepth":2,"teamId":"session-9"}"#,
        );
        assert_eq!(record.id(), "session-1");
        assert_eq!(record.created(), "2026-10-22T18:17:41.123Z");
        assert_eq!(record.updated(), None);
        assert_eq!(record.cwd(), "/x");
        assert_eq!(record.endpoint(), Some("e"));
        assert_eq!(record.model(), Some("m"));
        assert_eq!(record.reasoning_effort(), Some("high"));
        assert_eq!(record.title(), Some("T"));
        assert_eq!(record.turns(), 3);
        assert!(record.pinned());
        assert_eq!(record.pinned_at(), Some("2026-10-22T18:18:00.000Z"));
        assert!(!record.archived());
        assert_eq!(record.parent_session(), Some("session-0"));
        assert_eq!(record.origin(), Some(SessionOrigin::Subagent));
        assert_eq!(record.delegation_depth(), Some(2));
        assert_eq!(record.team_id(), Some("session-9"));
    }

    #[test]
    fn a_record_missing_a_field_reads_the_empty_answer() {
        let record = meta(r#"{"id":"session-1"}"#);
        assert_eq!(record.created(), "");
        assert_eq!(record.cwd(), "");
        assert_eq!(record.turns(), 0);
        assert!(!record.pinned());
        assert!(!record.archived());
        assert_eq!(record.origin(), None);
        assert_eq!(record.delegation_depth(), None);
    }

    #[test]
    fn the_file_text_is_json_stringify_with_two_spaces_and_a_newline() {
        let record = meta(r#"{"id":"session-1","created":"2026-10-22T18:17:41.123Z","turns":0}"#);
        assert_eq!(
            record.to_file_text(),
            "{\n  \"id\": \"session-1\",\n  \"created\": \"2026-10-22T18:17:41.123Z\",\n  \"turns\": 0\n}\n"
        );
    }

    #[test]
    fn an_edit_keeps_where_an_untouched_key_was() {
        // The spread `{ ...current, title }` puts `title` back where it was found, not at the end.
        let mut record = meta(r#"{"id":"s","title":"old","cwd":"/x"}"#);
        record.set("title", json!("new"));
        assert_eq!(
            record.to_file_text(),
            "{\n  \"id\": \"s\",\n  \"title\": \"new\",\n  \"cwd\": \"/x\"\n}\n"
        );
    }

    #[test]
    fn an_edit_appends_a_key_that_is_new_and_carries_unknown_ones() {
        let mut record = meta(r#"{"id":"s","cwd":"/x","custom":{"kept":true}}"#);
        record.set("updated", json!("2026-10-22T18:18:00.000Z"));
        assert_eq!(
            record.to_file_text(),
            "{\n  \"id\": \"s\",\n  \"cwd\": \"/x\",\n  \"custom\": {\n    \"kept\": true\n  },\n  \"updated\": \"2026-10-22T18:18:00.000Z\"\n}\n"
        );
    }

    #[test]
    fn deleting_a_key_leaves_the_rest_in_order() {
        let mut record = meta(r#"{"id":"s","title":"old","cwd":"/x"}"#);
        assert_eq!(record.remove("title"), Some(json!("old")));
        assert_eq!(
            record.to_file_text(),
            "{\n  \"id\": \"s\",\n  \"cwd\": \"/x\"\n}\n"
        );
        assert_eq!(record.remove("title"), None);
    }

    #[test]
    fn a_record_round_trips_through_serde_in_order() {
        let text = r#"{"id":"s","created":"t","cwd":"/x","turns":0,"unknown":[1,2]}"#;
        let record = meta(text);
        assert_eq!(serde_json::to_string(&record).unwrap(), text);
    }
}
