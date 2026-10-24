//! The one question every route about a session asks the store first: does it exist, and what did it record.

use serde_json::Value;

/// A lookup of sessions in the store, shared by every host trait that is asked about one session (here and in
/// `heddle-web-trajectory`).
pub trait SessionLookup: Send + Sync + 'static {
    /// Every event of the session's log, in order, as the JSON objects they were written as (key order kept);
    /// `None` when the store has no such session (`ctx.session.store.open(id) === null`).
    fn session_events(&self, id: &str) -> Option<Vec<Value>>;

    /// Whether the store has the session. The default reads the log; a host with a cheaper answer overrides it.
    fn session_exists(&self, id: &str) -> bool {
        self.session_events(id).is_some()
    }
}
