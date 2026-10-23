//! In-memory doubles of the crate's ports, for this crate's tests and for any crate that tests against the
//! team service without the real session store (feature `test-doubles`).
//!
//! They keep the promises the ports state — the store adds `seq` and `at`, the runner writes the prompt
//! before `begin` returns and registers the turn live — so a test against them judges the team layer, not the
//! double.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

use crate::ports::{
    ChildSession, PortError, SessionMetaView, TeamIds, TeamLive, TeamRunner, TeamSource, TeamStore,
    TurnFuture,
};
use crate::state::SessionId;

/// The fixed timestamp every appended event in a [`MemoryStore`] carries.
pub const FIXED_AT: &str = "2026-01-01T00:00:00.000Z";

/// One session in a [`MemoryStore`].
#[derive(Debug, Clone, Default)]
pub struct MemorySession {
    pub meta: SessionMetaView,
    /// Set for a session created by the team: the attribution it was created with.
    pub child: Option<ChildSession>,
    pub events: Vec<Value>,
}

/// A [`TeamStore`] in memory. `append` adds `seq` (0-based, per session) and a fixed `at`.
#[derive(Debug, Default)]
pub struct MemoryStore {
    sessions: Mutex<HashMap<SessionId, MemorySession>>,
    /// When set, `create` and `fork` fail with this reason.
    fail_creates: Mutex<Option<String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an existing session (a Lead, or a member a previous process left).
    pub fn add_session(&self, meta: SessionMetaView) {
        let mut sessions = self.sessions.lock().expect("the store lock");
        sessions.insert(
            meta.id.clone(),
            MemorySession {
                meta,
                child: None,
                events: Vec::new(),
            },
        );
    }

    /// The session's events so far; empty when it does not exist.
    pub fn events(&self, session: &str) -> Vec<Value> {
        self.sessions
            .lock()
            .expect("the store lock")
            .get(session)
            .map(|stored| stored.events.clone())
            .unwrap_or_default()
    }

    /// The session as stored, attribution included.
    pub fn session(&self, session: &str) -> Option<MemorySession> {
        self.sessions
            .lock()
            .expect("the store lock")
            .get(session)
            .cloned()
    }

    /// Make `create` and `fork` fail with `reason` (or succeed again with `None`).
    pub fn fail_creates(&self, reason: Option<&str>) {
        *self.fail_creates.lock().expect("the store lock") = reason.map(str::to_owned);
    }

    /// The stored session's events, refusing when it does not exist.
    fn events_of(&self, session: &str) -> Result<Vec<Value>, PortError> {
        self.sessions
            .lock()
            .expect("the store lock")
            .get(session)
            .map(|stored| stored.events.clone())
            .ok_or_else(|| PortError(format!("no session {session}")))
    }

    fn create_refused(&self) -> Option<PortError> {
        self.fail_creates
            .lock()
            .expect("the store lock")
            .clone()
            .map(PortError)
    }

    fn insert_child(&self, child: &ChildSession, events: Vec<Value>) -> Result<(), PortError> {
        let mut sessions = self.sessions.lock().expect("the store lock");
        if sessions.contains_key(&child.id) {
            return Err(PortError(format!("session {} already exists", child.id)));
        }
        sessions.insert(
            child.id.clone(),
            MemorySession {
                meta: SessionMetaView {
                    id: child.id.clone(),
                    cwd: child.cwd.clone(),
                    endpoint: child.endpoint.clone(),
                    model: child.model.clone(),
                    team_id: Some(child.team_id.clone()),
                },
                child: Some(child.clone()),
                events,
            },
        );
        Ok(())
    }
}

impl TeamStore for MemoryStore {
    fn exists(&self, session: &str) -> bool {
        self.sessions
            .lock()
            .expect("the store lock")
            .contains_key(session)
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, PortError> {
        self.events_of(session)
    }

    fn meta(&self, session: &str) -> Option<SessionMetaView> {
        self.sessions
            .lock()
            .expect("the store lock")
            .get(session)
            .map(|stored| stored.meta.clone())
    }

    fn list(&self) -> Vec<SessionId> {
        let sessions = self.sessions.lock().expect("the store lock");
        let mut ids: Vec<SessionId> = sessions.keys().cloned().collect();
        ids.sort();
        ids
    }

    fn create(&self, child: &ChildSession) -> Result<(), PortError> {
        if let Some(error) = self.create_refused() {
            return Err(error);
        }
        self.insert_child(child, Vec::new())
    }

    fn fork(&self, source: &str, child: &ChildSession) -> Result<bool, PortError> {
        if let Some(error) = self.create_refused() {
            return Err(error);
        }
        let Ok(events) = self.events_of(source) else {
            return Ok(false);
        };
        self.insert_child(child, events)?;
        Ok(true)
    }

    fn append(&self, session: &str, event: Value) -> Result<(), PortError> {
        let Value::Object(event) = event else {
            return Err(PortError(
                "a session event must be a JSON object".to_owned(),
            ));
        };
        let mut sessions = self.sessions.lock().expect("the store lock");
        let stored = sessions
            .get_mut(session)
            .ok_or_else(|| PortError(format!("no session {session}")))?;
        let mut record = Map::new();
        record.insert("seq".to_owned(), Value::from(stored.events.len()));
        record.insert("at".to_owned(), Value::from(FIXED_AT));
        record.extend(event);
        stored.events.push(Value::Object(record));
        Ok(())
    }

    fn user_message(
        &self,
        session: &str,
        content: Vec<Value>,
        source: Value,
    ) -> Result<(), PortError> {
        self.append(
            session,
            json!({
                "type": "message",
                "message": { "role": "user", "content": content, "source": source },
            }),
        )
    }

    fn inherit_recorded_mode(&self, _parent: &str, _child: &str) -> Result<(), PortError> {
        // The recorded permission mode is a session-store concern; the double has no modes to inherit.
        Ok(())
    }
}

/// A turn a [`RecordingRunner`] began.
#[derive(Debug, Clone, PartialEq)]
pub struct BegunTurn {
    pub session: SessionId,
    pub prompt: String,
    pub source: Value,
}

/// A [`TeamRunner`] that writes the prompt into a [`MemoryStore`], marks the session running in a
/// [`FakeLive`] (when given one) until the returned future completes, and records every turn it began.
pub struct RecordingRunner {
    store: Arc<MemoryStore>,
    live: Option<Arc<FakeLive>>,
    begun: Mutex<Vec<BegunTurn>>,
    /// When set, `begin` refuses with this reason and writes nothing.
    refuse: Mutex<Option<String>>,
}

impl RecordingRunner {
    pub fn new(store: Arc<MemoryStore>, live: Option<Arc<FakeLive>>) -> Self {
        Self {
            store,
            live,
            begun: Mutex::new(Vec::new()),
            refuse: Mutex::new(None),
        }
    }

    /// Every turn begun so far, in order.
    pub fn begun(&self) -> Vec<BegunTurn> {
        self.begun.lock().expect("the runner lock").clone()
    }

    /// Make `begin` refuse with `reason` (or accept again with `None`).
    pub fn refuse(&self, reason: Option<&str>) {
        *self.refuse.lock().expect("the runner lock") = reason.map(str::to_owned);
    }
}

impl TeamRunner for RecordingRunner {
    fn begin(
        &self,
        session: &str,
        prompt: &str,
        source: &TeamSource,
    ) -> Result<TurnFuture, String> {
        if let Some(reason) = self.refuse.lock().expect("the runner lock").clone() {
            return Err(reason);
        }
        let source_value = source.to_value();
        self.store
            .user_message(
                session,
                vec![json!({ "type": "text", "text": prompt })],
                source_value.clone(),
            )
            .map_err(|error| error.0)?;
        if let Some(live) = &self.live {
            live.set_running(session, true);
        }
        self.begun.lock().expect("the runner lock").push(BegunTurn {
            session: session.to_owned(),
            prompt: prompt.to_owned(),
            source: source_value,
        });
        let live = self.live.clone();
        let session = session.to_owned();
        Ok(Box::pin(async move {
            if let Some(live) = live {
                live.set_running(&session, false);
            }
            Ok(())
        }))
    }
}

/// A [`TeamLive`] whose running set a test controls, recording every abort.
#[derive(Debug, Default)]
pub struct FakeLive {
    running: Mutex<HashSet<SessionId>>,
    aborted: Mutex<Vec<SessionId>>,
}

impl FakeLive {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_running(&self, session: &str, running: bool) {
        let mut set = self.running.lock().expect("the live lock");
        if running {
            set.insert(session.to_owned());
        } else {
            set.remove(session);
        }
    }

    /// Every session `abort` was called for, in order.
    pub fn aborted(&self) -> Vec<SessionId> {
        self.aborted.lock().expect("the live lock").clone()
    }
}

impl TeamLive for FakeLive {
    fn is_running(&self, session: &str) -> bool {
        self.running
            .lock()
            .expect("the live lock")
            .contains(session)
    }

    fn abort(&self, session: &str) -> bool {
        self.aborted
            .lock()
            .expect("the live lock")
            .push(session.to_owned());
        self.running.lock().expect("the live lock").remove(session)
    }
}

/// Deterministic [`TeamIds`]: `session-member-1`, `session-member-2`, … and `team-message-1`, ….
#[derive(Debug, Default)]
pub struct SequentialIds {
    sessions: Mutex<u64>,
    messages: Mutex<u64>,
}

impl SequentialIds {
    pub fn new() -> Self {
        Self::default()
    }
}

impl TeamIds for SequentialIds {
    fn session_id(&self) -> SessionId {
        let mut count = self.sessions.lock().expect("the ids lock");
        *count += 1;
        format!("session-member-{count}")
    }

    fn message_id(&self) -> String {
        let mut count = self.messages.lock().expect("the ids lock");
        *count += 1;
        format!("team-message-{count}")
    }
}
