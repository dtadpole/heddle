//! The session log a request lives in: three verbs over string ids and JSON, as `heddle-goal`'s `SessionLog`.
//!
//! Kept separate from the goal's trait so either plugin loads without the other. The production implementation is
//! `heddle-session`'s store; the tests use the same store over a temporary directory.

use heddle_session::{AppendOptions, NewEvent, SessionStore};
use serde_json::{Map, Value};

/// A log read or write that failed, with the store's own sentence.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct LogError(pub String);

/// The session log the question service event-sources from.
pub trait QuestionLog: Send + Sync {
    /// The session's id when it exists.
    fn open(&self, id: &str) -> Option<String>;
    /// Every event of the session, oldest first, as JSON objects.
    fn read(&self, session: &str) -> Result<Vec<Value>, LogError>;
    /// Append one event (the store adds `seq` and `at`) and return it as written.
    fn append(&self, session: &str, event: Map<String, Value>) -> Result<Value, LogError>;
}

impl QuestionLog for SessionStore {
    fn open(&self, id: &str) -> Option<String> {
        SessionStore::open(self, id).map(|handle| handle.id)
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, LogError> {
        let handle = SessionStore::open(self, session).ok_or_else(|| LogError(format!("no session {session}")))?;
        let events = SessionStore::read(self, &handle).map_err(|error| LogError(error.to_string()))?;
        Ok(events.iter().map(|event| event.to_value()).collect())
    }

    fn append(&self, session: &str, event: Map<String, Value>) -> Result<Value, LogError> {
        let handle = SessionStore::open(self, session).ok_or_else(|| LogError(format!("no session {session}")))?;
        let body = NewEvent::try_from(Value::Object(event)).map_err(|error| LogError(error.to_string()))?;
        let written = SessionStore::append(self, &handle, body, AppendOptions::default()).map_err(|error| LogError(error.to_string()))?;
        Ok(written.to_value())
    }
}
