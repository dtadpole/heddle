//! The **definition** of one session, written into the folder it belongs to.
//!
//! Ported from `src/session/definition.ts`. The owner's ruling of 2026-10-11 splits a session in two:
//! the **log** is machine state outside every repository; the **definition** — which log, which folder,
//! how it is run — is written under `<branch>/_sessions_/<name>/` and is meant to be committed. The name
//! comes from the clock (`session-<yyyymmdd>-<hhmm>`, local time), is a valid instance name, and sorts
//! chronologically.
//!
//! `session.json` is `JSON.stringify(fields, null, 2)` plus a newline; `INDEX.md` and the
//! `_sessions_/INDEX.md` the tool creates are the TypeScript build's text, byte for byte.

use serde_json::{Map, Value};

use crate::error::SessionError;
use crate::event::SessionHandle;

/// The type folder a branch's sessions live in. The tree never draws it; it hoists what is inside.
pub const SESSIONS_FOLDER: &str = "_sessions_";

/// The machine-readable half of a definition.
pub const DEFINITION_FILE: &str = "session.json";

/// Where a definition went, as the harness reads it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDefinition {
    /// The instance name, which is also the folder's name.
    pub name: String,
    /// The `_sessions_/<name>` folder.
    pub dir: String,
    /// The `session.json` inside it.
    pub file: String,
    /// The log this definition references, as the store keeps it.
    pub log: String,
}

/// The fields of a `session.json`: `id`, `log`, `cwd`, `createdAt`, `title?`, `endpoint?`, `model?`,
/// `reasoningEffort?` — kept as the ordered object on disk, so an update keeps unknown keys and order.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionDefinitionFields {
    raw: Map<String, Value>,
}

impl SessionDefinitionFields {
    /// Accept a parsed `session.json`: `None` unless `id` is a non-empty string.
    pub fn from_value(value: Value) -> Option<Self> {
        todo!()
    }
    pub fn as_map(&self) -> &Map<String, Value> {
        &self.raw
    }
    pub fn id(&self) -> &str {
        todo!()
    }
    pub fn log(&self) -> Option<&str> {
        todo!()
    }
    pub fn cwd(&self) -> Option<&str> {
        todo!()
    }
    pub fn created_at(&self) -> Option<&str> {
        todo!()
    }
    pub fn title(&self) -> Option<&str> {
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
}

/// What `write_session_definition` is told.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DefinitionOptions {
    /// The session's creation time, as `toISOString` wrote it; the name is taken from it in local time.
    pub created_at: String,
    pub title: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    /// The names already in the branch's `_sessions_` folder, so two sessions in one minute differ.
    pub taken: Vec<String>,
}

/// A session handle and the definition written for it — what `create_at` and `fork` answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedDefinition {
    pub handle: SessionHandle,
    pub definition: SessionDefinition,
}

/// A name for a new session: `session-<yyyymmdd>-<hhmm>` in local time, then `-2` … `-99` when that
/// minute is taken. [`SessionError::NamesExhausted`] past a hundred.
pub fn session_name<Tz: chrono::TimeZone>(
    now: &chrono::DateTime<Tz>,
    taken: &[String],
) -> Result<String, SessionError> {
    todo!()
}

/// Create a branch's `_sessions_` folder and its `INDEX.md` when they are not there yet; answers with
/// the folder.
pub fn ensure_sessions_folder(branch: &str) -> Result<String, SessionError> {
    todo!()
}

/// Write a session's definition under a branch — `session.json` and `INDEX.md` in a new
/// `_sessions_/<name>/` — and answer with where it went. The log is never touched.
pub fn write_session_definition(
    handle: &SessionHandle,
    branch: &str,
    options: &DefinitionOptions,
) -> Result<SessionDefinition, SessionError> {
    todo!()
}

/// The session names a branch already holds (the directories of its `_sessions_`), in byte order;
/// empty when it has none.
pub fn existing_session_names(branch: &str) -> Vec<String> {
    todo!()
}

/// What a definition folder says, read back; `None` when there is none or it is not readable.
pub fn read_session_definition(dir: &str) -> Option<SessionDefinitionFields> {
    todo!()
}

/// Retitle a definition so the committed record and the label agree; a blank title deletes the key.
/// `Ok(false)` when the folder holds no readable definition.
pub fn update_session_definition(dir: &str, title: Option<&str>) -> Result<bool, SessionError> {
    todo!()
}
