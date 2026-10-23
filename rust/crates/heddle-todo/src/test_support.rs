//! Test doubles for the session log and the clock, and a service built over them; compiled only for tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::log::{Clock, LogError, SessionLog};
use crate::service::{TodoConfig, TodoService};

/// The instant every fixture write is stamped with.
pub(crate) const FIXED_NOW: &str = "2026-10-22T00:00:00.000Z";

/// A session log in memory: sessions created by [`create`](MemoryLog::create), events appended with the
/// `seq` and `at` a store puts in front of the body.
#[derive(Default)]
pub(crate) struct MemoryLog {
    sessions: Mutex<HashMap<String, Vec<Value>>>,
    next_seq: Mutex<u64>,
}

impl MemoryLog {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Create one empty session.
    pub(crate) fn create(&self, id: &str) {
        self.sessions
            .lock()
            .unwrap()
            .entry(id.to_owned())
            .or_default();
    }

    /// Append an event body exactly as given — for a log the fold must refuse.
    pub(crate) fn append_raw(&self, session: &str, body: Value) {
        self.sessions
            .lock()
            .unwrap()
            .get_mut(session)
            .expect("the session exists")
            .push(body);
    }
}

impl SessionLog for MemoryLog {
    fn open(&self, id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .contains_key(id)
            .then(|| id.to_owned())
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, LogError> {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .cloned()
            .ok_or_else(|| LogError(format!("no session {session}")))
    }

    fn append(&self, session: &str, event: Map<String, Value>) -> Result<Value, LogError> {
        let sequence = {
            let mut next = self.next_seq.lock().unwrap();
            *next += 1;
            *next
        };
        let mut written = Map::new();
        written.insert("seq".to_owned(), Value::from(sequence));
        written.insert("at".to_owned(), Value::String(FIXED_NOW.to_owned()));
        for (key, value) in event {
            written.insert(key, value);
        }
        let written = Value::Object(written);
        let mut sessions = self.sessions.lock().unwrap();
        let events = sessions
            .get_mut(session)
            .ok_or_else(|| LogError(format!("no session {session}")))?;
        events.push(written.clone());
        Ok(written)
    }
}

/// A clock fixed at one instant.
pub(crate) struct FixedClock(pub(crate) &'static str);

impl Clock for FixedClock {
    fn now(&self) -> String {
        self.0.to_owned()
    }
}

/// A fresh log with one session, and the service over it with a fixed clock.
pub(crate) fn fixture(session: &str) -> (Arc<MemoryLog>, TodoService) {
    let log = Arc::new(MemoryLog::new());
    log.create(session);
    let service = TodoService::new(log.clone(), TodoConfig::default())
        .with_clock(Arc::new(FixedClock(FIXED_NOW)));
    (log, service)
}
