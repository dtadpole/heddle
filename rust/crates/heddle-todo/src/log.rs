//! The ports this crate needs: the session log it event-sources from, and the clock that stamps a write.

use std::time::SystemTime;

use serde_json::{Map, Value};

/// The session log could not be opened, read or appended.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct LogError(pub String);

/// The session log, as a plugin that event-sources its state needs it — the TypeScript `SessionStore`'s
/// `open`, `read` and `append`.
///
/// Events are JSON objects as written: `{"seq":…,"at":…,"type":…, …}`. Implemented for `heddle-session`'s
/// store once its API lands; tests use an in-memory double.
pub trait SessionLog: Send + Sync {
    /// The canonical id of the session `id` names, or `None` when there is no such session.
    fn open(&self, id: &str) -> Option<String>;
    /// Every event of the session, in order.
    fn read(&self, session: &str) -> Result<Vec<Value>, LogError>;
    /// Append one event body — `type` and its fields, in order; the log adds `seq` and `at` in front — and
    /// return the event as written.
    fn append(&self, session: &str, event: Map<String, Value>) -> Result<Value, LogError>;
}

/// Where a write's `updatedAt` comes from; injected so a test can fix it.
pub trait Clock: Send + Sync {
    /// Now, as [`iso_timestamp`] formats it.
    fn now(&self) -> String;
}

/// The system clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> String {
        iso_timestamp(SystemTime::now())
    }
}

/// A time as JavaScript's `Date.prototype.toISOString` writes it: UTC, milliseconds, `Z` —
/// `2026-10-22T18:17:40.123Z`. The session log's timestamps are compared as text, so the format is exact.
pub fn iso_timestamp(time: SystemTime) -> String {
    let _ = time;
    todo!("heddle-todo: iso_timestamp")
}
