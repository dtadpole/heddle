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
        todo!()
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
        todo!()
    }

    pub fn id(&self) -> &str {
        todo!()
    }
    /// When it was created; `""` when the record has none.
    pub fn created(&self) -> &str {
        todo!()
    }
    /// When it was last written to — the age a row shows.
    pub fn updated(&self) -> Option<&str> {
        todo!()
    }
    /// The folder the session is bound to; `""` when a legacy record has none.
    pub fn cwd(&self) -> &str {
        todo!()
    }
    pub fn endpoint(&self) -> Option<&str> {
        todo!()
    }
    pub fn model(&self) -> Option<&str> {
        todo!()
    }
    pub fn reasoning_effort(&self) -> Option<&str> {
        todo!()
    }
    pub fn title(&self) -> Option<&str> {
        todo!()
    }
    /// User turns recorded; 0 when absent.
    pub fn turns(&self) -> u64 {
        todo!()
    }
    pub fn pinned(&self) -> bool {
        todo!()
    }
    pub fn pinned_at(&self) -> Option<&str> {
        todo!()
    }
    pub fn archived(&self) -> bool {
        todo!()
    }
    /// The session that delegated this one, when this is a subagent's.
    pub fn parent_session(&self) -> Option<&str> {
        todo!()
    }
    pub fn origin(&self) -> Option<SessionOrigin> {
        todo!()
    }
    pub fn delegation_depth(&self) -> Option<u64> {
        todo!()
    }
    /// The Lead's session id, when this session is a teammate's.
    pub fn team_id(&self) -> Option<&str> {
        todo!()
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
