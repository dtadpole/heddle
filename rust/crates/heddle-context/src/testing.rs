//! An in-memory [`ContextStore`], for this crate's tests and a dependent crate's.
//!
//! It keeps one log per session in memory and folds the surface by the rules of
//! `src/session/store.ts` — one node per `message` or `context/note`, one node per streamed
//! assistant run, a replacement splicing the positions it names — and it refuses the replacements
//! that store refuses (a range that is not a span; a rewritten system head; a tool result rewritten
//! by anything but a tool result for the same call). It is a double, not the store: no files, no
//! metadata, no zstd. Enabled by the `testing` feature.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use crate::store::{AppendOptions, ContextStore, LogEvent, StoreError, SurfaceState};
use crate::types::Message;

/// Names one session of a [`MemoryStore`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MemorySession(pub String);

/// An in-memory session store.
#[derive(Debug, Default)]
pub struct MemoryStore {
    logs: Mutex<HashMap<String, Vec<LogEvent>>>,
}

impl MemoryStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Open (or create) a session by id.
    pub fn open(&self, id: &str) -> MemorySession {
        let _ = (id, &self.logs);
        todo!("MemoryStore::open")
    }

    /// Record a `message` event, as `SessionStore.message` does; returns its seq.
    pub fn message(&self, session: &MemorySession, message: Message) -> u64 {
        let _ = (session, message);
        todo!("MemoryStore::message")
    }

    /// Record one `assistant/chunk` event carrying `chunk` (`{"type":"text-delta",…}`, `…"done"…`).
    pub fn assistant_chunk(&self, session: &MemorySession, chunk: Value) -> u64 {
        let _ = (session, chunk);
        todo!("MemoryStore::assistant_chunk")
    }
}

impl ContextStore for MemoryStore {
    type Handle = MemorySession;

    fn count(&self, session: &MemorySession) -> Result<u64, StoreError> {
        let _ = session;
        todo!("MemoryStore::count")
    }

    fn read(&self, session: &MemorySession) -> Result<Vec<LogEvent>, StoreError> {
        let _ = session;
        todo!("MemoryStore::read")
    }

    fn surface(&self, session: &MemorySession) -> Result<SurfaceState, StoreError> {
        let _ = session;
        todo!("MemoryStore::surface")
    }

    fn derive_node(
        &self,
        session: &MemorySession,
        seq: u64,
    ) -> Result<Option<Message>, StoreError> {
        let _ = (session, seq);
        todo!("MemoryStore::derive_node")
    }

    fn append(
        &self,
        session: &MemorySession,
        event: Value,
        options: AppendOptions,
    ) -> Result<u64, StoreError> {
        let _ = (session, event, options);
        todo!("MemoryStore::append")
    }
}
