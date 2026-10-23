//! In-memory doubles of the crate's ports, for this crate's tests and for any crate that tests against the
//! team service without the real session store (feature `test-doubles`).
//!
//! They keep the promises the ports state — the store adds `seq` and `at`, the runner writes the prompt
//! before `begin` returns and registers the turn live — so a test against them judges the team layer, not the
//! double.

// Contract stage: the bodies below are `todo!()` until the doubles land (port plan, step M2).
#![allow(unused_variables, dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::ports::{
    ChildSession, PortError, SessionMetaView, TeamIds, TeamLive, TeamRunner, TeamSource, TeamStore,
    TurnFuture,
};
use crate::state::SessionId;

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
        todo!("M2")
    }

    /// The session's events so far; empty when it does not exist.
    pub fn events(&self, session: &str) -> Vec<Value> {
        todo!("M2")
    }

    /// The session as stored, attribution included.
    pub fn session(&self, session: &str) -> Option<MemorySession> {
        todo!("M2")
    }

    /// Make `create` and `fork` fail with `reason` (or succeed again with `None`).
    pub fn fail_creates(&self, reason: Option<&str>) {
        todo!("M2")
    }
}

impl TeamStore for MemoryStore {
    fn exists(&self, session: &str) -> bool {
        todo!("M2")
    }
    fn read(&self, session: &str) -> Result<Vec<Value>, PortError> {
        todo!("M2")
    }
    fn meta(&self, session: &str) -> Option<SessionMetaView> {
        todo!("M2")
    }
    fn list(&self) -> Vec<SessionId> {
        todo!("M2")
    }
    fn create(&self, child: &ChildSession) -> Result<(), PortError> {
        todo!("M2")
    }
    fn fork(&self, source: &str, child: &ChildSession) -> Result<bool, PortError> {
        todo!("M2")
    }
    fn append(&self, session: &str, event: Value) -> Result<(), PortError> {
        todo!("M2")
    }
    fn user_message(
        &self,
        session: &str,
        content: Vec<Value>,
        source: Value,
    ) -> Result<(), PortError> {
        todo!("M2")
    }
    fn inherit_recorded_mode(&self, parent: &str, child: &str) -> Result<(), PortError> {
        todo!("M2")
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
        todo!("M2")
    }

    /// Every turn begun so far, in order.
    pub fn begun(&self) -> Vec<BegunTurn> {
        todo!("M2")
    }

    /// Make `begin` refuse with `reason` (or accept again with `None`).
    pub fn refuse(&self, reason: Option<&str>) {
        todo!("M2")
    }
}

impl TeamRunner for RecordingRunner {
    fn begin(
        &self,
        session: &str,
        prompt: &str,
        source: &TeamSource,
    ) -> Result<TurnFuture, String> {
        todo!("M2")
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
        todo!("M2")
    }

    /// Every session `abort` was called for, in order.
    pub fn aborted(&self) -> Vec<SessionId> {
        todo!("M2")
    }
}

impl TeamLive for FakeLive {
    fn is_running(&self, session: &str) -> bool {
        todo!("M2")
    }
    fn abort(&self, session: &str) -> bool {
        todo!("M2")
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
        todo!("M2")
    }
    fn message_id(&self) -> String {
        todo!("M2")
    }
}
