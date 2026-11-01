//! Test doubles for the session log, the clock and the id source; compiled only for tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::log::{Clock, LogError, SessionLog};
use crate::service::{GoalConfig, GoalId, GoalIds, GoalService};

/// The instant every fixture change is stamped with.
pub(crate) const FIXED_NOW: &str = "2026-10-22T00:00:00.000Z";

/// A session log in memory: sessions created by [`create`](MemoryLog::create), events appended with the
/// `seq` and `at` a store puts in front of the body.
#[derive(Default)]
pub(crate) struct MemoryLog {
    sessions: Mutex<HashMap<String, Vec<Value>>>,
    metas: Mutex<HashMap<String, Value>>,
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

    /// Append an event body exactly as given — a round's user message, or a log the fold must refuse.
    pub(crate) fn append_raw(&self, session: &str, body: Value) {
        self.sessions
            .lock()
            .unwrap()
            .get_mut(session)
            .expect("the session exists")
            .push(body);
    }

    /// Give one session a metadata record, as a store writes it (`delegationDepth` for a delegated session).
    pub(crate) fn set_meta(&self, session: &str, meta: Value) {
        self.metas.lock().unwrap().insert(session.to_owned(), meta);
    }

    /// Every event of one session, as read.
    pub(crate) fn events(&self, session: &str) -> Vec<Value> {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .cloned()
            .unwrap_or_default()
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

    fn meta(&self, session: &str) -> Option<Value> {
        self.metas.lock().unwrap().get(session).cloned()
    }
}

/// A clock fixed at one instant.
pub(crate) struct FixedClock(pub(crate) &'static str);

impl Clock for FixedClock {
    fn now(&self) -> String {
        self.0.to_owned()
    }
}

/// Ids from a counter, so a test can know them.
#[derive(Default)]
pub(crate) struct FixedIds {
    next: Mutex<u64>,
}

impl GoalIds for FixedIds {
    fn next_id(&self) -> GoalId {
        let mut next = self.next.lock().unwrap();
        *next += 1;
        format!("goal-test-{}", *next)
    }
}

/// A fresh log with one session, and the service over it with a fixed clock and fixed ids.
pub(crate) fn fixture(session: &str) -> (Arc<MemoryLog>, GoalService) {
    let log = Arc::new(MemoryLog::new());
    log.create(session);
    let service = GoalService::new(log.clone(), GoalConfig::default())
        .with_clock(Arc::new(FixedClock(FIXED_NOW)))
        .with_ids(Arc::new(FixedIds::default()));
    (log, service)
}
