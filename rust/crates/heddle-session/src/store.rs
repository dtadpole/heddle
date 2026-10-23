//! The session store: an append-only event log per session, filed under its workspace folder.
//!
//! Ported from `SessionStore` in `src/session/store.ts`, modelled on `@deepseek-ai/dsh-session`.
//!
//! - **An event is on disk before the thing it describes happens.** `append` writes synchronously and
//!   only then tells the listener, so a listener never sees an event the file does not have.
//! - **A torn tail is cut off when the session is opened**, and the repair is recorded as a
//!   `transcript/repaired` event carrying `droppedBytes`. Without it, every event appended after a tear
//!   sits in the file unread.
//! - **A process that has opened a session reads it from memory.** The file is decoded once; every
//!   later read, count and derivation is served from that fold, and the surface is cached by event count.
//!   A second process appending to the same session would not be seen — heddle runs one per session.
//! - **Two layouts are read, one is written**: `<root>/<workspace-key>/<id>.v2.jsonl.zstd` + `<id>.json`
//!   for a new session; `<root>/<id>/{session.v2.jsonl.zstd|session.jsonl, meta.json}` for an old one,
//!   which keeps the shape and the format it was born with.
//!
//! # Threads
//!
//! The store is `Send + Sync` and every method takes `&self`; share it as `Arc<SessionStore>`. One
//! internal lock serializes the fold and the file writes, so a seq is assigned and written atomically.
//! The listener is called **after** the lock is released, so it may read the store.

use std::sync::Arc;

use heddle_config::Env;
use serde::Serialize;

use crate::error::SessionError;
use crate::event::{AppendOptions, Events, NewEvent, SessionEvent, SessionHandle};
use crate::message::{Chunk, Message, RecordedMessage};
use crate::meta::{CreateOptions, FlagPatch, ForkAttribution, ModelSelection, SessionMeta};
use crate::surface::SurfaceState;

/// The transcript file name inside an **old-layout** session directory, current format.
pub const TRANSCRIPT_NAME: &str = "session.v2.jsonl.zstd";
/// The transcript file name inside an old-layout session directory, plain JSONL (v1).
pub const LEGACY_TRANSCRIPT_NAME: &str = "session.jsonl";

/// Told about every event after it is on disk, and about every live-only tool-call fragment.
///
/// This is the seam the command line's printer and the Web UI's stream listen on; the boot wires it to
/// the `session/event` hook (`{ session: handle.id, event }`).
pub type EventListener = Arc<dyn Fn(&SessionHandle, &SessionEvent) + Send + Sync>;

/// The default store root: `heddle_home(env)/sessions` — `$HEDDLE_HOME/sessions`, else
/// `~/.heddle/sessions`.
pub fn default_session_root(env: &Env) -> String {
    todo!()
}

/// Whether a transcript path is one of the zstd-framed ones — asked of the suffix `.v2.jsonl.zstd`,
/// because both `session.v2.jsonl.zstd` and `<id>.v2.jsonl.zstd` are.
pub fn is_framed(path: &str) -> bool {
    todo!()
}

/// Whether this build can compress. Always true in Rust; kept so a caller ported from the TypeScript
/// build reads the same.
pub fn can_compress() -> bool {
    true
}

/// The log's file name for one session id in the workspace-folder layout: `<id>.v2.jsonl.zstd`.
pub fn log_name(id: &str) -> String {
    todo!()
}

/// The metadata's file name for one session id, beside its log: `<id>.json`.
pub fn meta_name(id: &str) -> String {
    todo!()
}

/// The transcript an old-layout session directory holds, preferring the current format, and the
/// current format's name when it holds neither.
pub fn transcript_in(dir: &str) -> String {
    todo!()
}

/// The meter sections of one request.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ModelRequestBreakdown {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<u64>,
}

/// Which model call produced an answer, recorded before it is made as a `model/request` event.
///
/// Written in field order after `type`, absent fields omitted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestRecord {
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// How many messages the request carries.
    pub messages: u64,
    /// The tool names offered.
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pruned: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compacted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<ModelRequestBreakdown>,
    /// The surface generation the request was built at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
}

/// The session store. See the module documentation.
pub struct SessionStore {
    root: String,
    listener: Option<EventListener>,
    state: std::sync::Mutex<StoreState>,
}

/// The fold and the surface cache, behind the store's one lock.
#[derive(Default)]
struct StoreState {}

impl std::fmt::Debug for SessionStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionStore")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl SessionStore {
    /// A store rooted at `root`: a leading `~` expanded with `heddle_config::expand_home`, then resolved
    /// to an absolute path. Nothing is created until the first session is.
    pub fn new(root: &str, env: &Env) -> Self {
        todo!()
    }

    /// A store whose appends are also handed to `listener`.
    pub fn with_listener(root: &str, env: &Env, listener: EventListener) -> Self {
        todo!()
    }

    /// The absolute root every session is filed under.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// Create a session filed under its workspace folder: write `<id>.json`, create the empty log, and
    /// append `session/created` with the `cwd`.
    pub fn create(&self, options: CreateOptions) -> Result<SessionHandle, SessionError> {
        todo!()
    }

    /// Retitle a session; a blank title deletes the key. `Ok(None)` when there is no such session.
    pub fn rename(&self, id: &str, title: &str) -> Result<Option<SessionMeta>, SessionError> {
        todo!()
    }

    /// Set or clear pinned and archived in one write, answering with the record as it now is.
    /// `Ok(None)` for an unknown session; [`SessionError::Flag`] for a refused pin.
    pub fn flags(&self, id: &str, patch: FlagPatch) -> Result<Option<SessionMeta>, SessionError> {
        todo!()
    }

    /// Copy a session's **projected** messages, cut at its last completed turn and without system
    /// messages, into a new session that inherits its `cwd`, endpoint, model and reasoning level.
    /// `Ok(None)` when the source does not exist.
    pub fn fork(
        &self,
        source: &str,
        attribution: ForkAttribution,
    ) -> Result<Option<SessionHandle>, SessionError> {
        todo!()
    }

    /// Record which endpoint and model a session runs with, replacing the previous selection.
    /// `Ok(None)` for an unknown session or a blank endpoint.
    pub fn set_model(
        &self,
        id: &str,
        selection: ModelSelection,
    ) -> Result<Option<SessionMeta>, SessionError> {
        todo!()
    }

    /// Open an existing session by id, in whichever layout it was written in.
    pub fn open(&self, id: &str) -> Option<SessionHandle> {
        todo!()
    }

    /// Open the newest session (by `created`), if there is one.
    pub fn open_newest(&self) -> Option<SessionHandle> {
        todo!()
    }

    /// Every session, newest `created` first, from both layouts, none twice. A file that is not
    /// metadata is skipped rather than failing the list. Directory entries are visited in byte order,
    /// as Node's `readdirSync` returns them.
    pub fn list(&self) -> Vec<SessionMeta> {
        todo!()
    }

    /// Append one event and answer with it as recorded.
    ///
    /// A `Replace` op is validated first: the event must be surface-eligible; the range must be a span
    /// of current positions; a system prompt at the surface head may be rewritten only by a system
    /// message over exactly that node; a tool result may be rewritten by a tool message only for the
    /// same call, over exactly that node. `turn/completed`, `assistant/completed` and `context/note`
    /// also touch the meta record's `updated`.
    pub fn append(
        &self,
        handle: &SessionHandle,
        event: NewEvent,
        options: AppendOptions,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        todo!()
    }

    /// How many events the session holds, which is also the next event's seq.
    pub fn count(&self, handle: &SessionHandle) -> Result<u64, SessionError> {
        todo!()
    }

    /// Every event, in order, from the fold. Fails naming the line when one does not parse.
    pub fn read(&self, handle: &SessionHandle) -> Result<Events, SessionError> {
        todo!()
    }

    /// Whether this session's transcript is stored as frames.
    pub fn framed(&self, handle: &SessionHandle) -> Result<bool, SessionError> {
        todo!()
    }

    /// The transcript's bytes on disk, empty when there is no file yet.
    pub fn bytes(&self, handle: &SessionHandle) -> Vec<u8> {
        todo!()
    }

    /// The surface, folded from the log and cached until the log grows.
    pub fn surface(&self, handle: &SessionHandle) -> Result<Arc<SurfaceState>, SessionError> {
        todo!()
    }

    /// One node's derived message, or `None` when the node produces none.
    pub fn derive_node(
        &self,
        handle: &SessionHandle,
        seq: u64,
    ) -> Result<Option<Message>, SessionError> {
        todo!()
    }

    /// The messages a request carries: every surface node, derived, in surface order.
    pub fn derive_messages(&self, handle: &SessionHandle) -> Result<Vec<Message>, SessionError> {
        todo!()
    }

    /// The messages a resumed session would send — the same as [`SessionStore::derive_messages`].
    pub fn messages(&self, handle: &SessionHandle) -> Result<Vec<Message>, SessionError> {
        todo!()
    }

    /// Record a `message` event, and in the same meta write move `updated` and count a user turn.
    pub fn message(
        &self,
        handle: &SessionHandle,
        message: RecordedMessage,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        todo!()
    }

    /// Record one streamed chunk as an `assistant/chunk` event.
    ///
    /// A `tool-call-delta` is **published, never recorded**: the listener gets a transient event
    /// (`transient: true`, the next real seq) and the log does not grow. `Ok(None)` in that case.
    pub fn assistant_chunk(
        &self,
        handle: &SessionHandle,
        chunk: &Chunk,
    ) -> Result<Option<Arc<SessionEvent>>, SessionError> {
        todo!()
    }

    /// Record which model call produced the answer, before it is made, as `model/request`.
    pub fn model_request(
        &self,
        handle: &SessionHandle,
        request: &ModelRequestRecord,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        todo!()
    }

    /// The `text` of the last `assistant/completed` event, `""` when there is none.
    pub fn last_answer(&self, handle: &SessionHandle) -> Result<String, SessionError> {
        todo!()
    }

    /// Record that the session was written to (`updated`), optionally counting a user turn in the same
    /// write. A meta file that cannot be read or written is ignored: losing the count must never lose
    /// the event that was just appended.
    pub fn touch(&self, handle: &SessionHandle, bump_turns: bool) {
        todo!()
    }
}
