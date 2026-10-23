//! The store port: what this crate needs from the session log, declared here rather than imported.
//!
//! It follows `PrunableStore` in `src/context/prune.ts`. A structural interface keeps every module
//! here testable against an in-memory double (`testing::MemoryStore`, behind the `testing`
//! feature), and `heddle-session`'s store satisfies it through one adapter `impl` in this crate
//! once that crate publishes its API — the adapter lives here because this crate owns the trait,
//! and `heddle-session` must not depend on `heddle-context`.
//!
//! The surface itself — the fold, the replacement rules, the derivation of a streamed run into one
//! assistant message — belongs to the store. This crate only asks for its results.

use serde_json::{Map, Value};

use crate::types::Message;

/// One event as the log holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct LogEvent {
    /// The event's position in the log; monotonic within a session.
    pub seq: u64,
    /// The event's `type`, such as `context/note` or `model/request`.
    pub kind: String,
    /// Every other field as written, including `at`, `surfaceOp` and `sourceEventSeqs`.
    pub fields: Map<String, Value>,
}

impl LogEvent {
    /// One field, when present.
    pub fn field(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }

    /// The `origin` of a `context/note`: `system-prompt`, `instructions`, `compaction`,
    /// `runtime-context`, or a legacy `sandbox-policy`.
    pub fn origin(&self) -> Option<&str> {
        todo!("LogEvent::origin")
    }

    /// The `identity` a note was rendered from, when it is a string.
    pub fn identity(&self) -> Option<&str> {
        todo!("LogEvent::identity")
    }

    /// The `message` a `message` or `context/note` event carries, parsed.
    pub fn message(&self) -> Option<Message> {
        todo!("LogEvent::message")
    }

    /// How the event entered the surface; `None` when it carries no marker (an append, in an old log).
    pub fn surface_op(&self) -> Option<SurfaceOp> {
        todo!("LogEvent::surface_op")
    }
}

/// A range of surface positions named by the seqs at its two ends.
///
/// The range is **positional**: after one replacement the seqs inside it need not be ordered, and
/// `start_seq` may be greater than `end_seq`. The store takes the positions between the two ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeqRange {
    /// The seq at the first position shadowed.
    pub start_seq: u64,
    /// The seq at the last position shadowed.
    pub end_seq: u64,
}

/// How an event enters the surface (`SurfaceOp`): `"append"`, or
/// `{"op":"replace","startSeq":…,"endSeq":…}` in the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceOp {
    /// Take the next position.
    Append,
    /// Shadow the positions of a span, taking their place.
    Replace(SeqRange),
}

impl SurfaceOp {
    /// The JSON the log stores for this operation.
    pub fn to_json(&self) -> Value {
        todo!("SurfaceOp::to_json")
    }

    /// The operation a log's `surfaceOp` field names, or `None` when it names none.
    pub fn from_json(value: &Value) -> Option<Self> {
        let _ = value;
        todo!("SurfaceOp::from_json")
    }
}

/// The positional view of a log: the nodes the model can see, in order (`SurfaceState`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SurfaceState {
    /// The seq of every node in surface order, which is not seq order after a replacement.
    pub nodes: Vec<u64>,
    /// Bumped by an append and by a replacement; the usage anchor's key.
    pub content_generation: u64,
    /// Bumped only by a replacement: "a rewrite has landed", which is what an overflow retry waits for.
    pub replace_generation: u64,
}

/// One surface node and the message it derives to.
#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceNode {
    /// The node's seq.
    pub seq: u64,
    /// Its message, or `None` when the node produces none (an empty message, a run with no content).
    pub message: Option<Message>,
}

/// How an appended event relates to the surface.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppendOptions {
    /// `None` and [`SurfaceOp::Append`] both append; the difference is whether the marker is written.
    pub surface_op: Option<SurfaceOp>,
    /// The events a replacement was made from, written as `sourceEventSeqs`.
    pub source_event_seqs: Option<Vec<u64>>,
}

impl AppendOptions {
    /// Write the `"append"` marker.
    pub fn append() -> Self {
        todo!("AppendOptions::append")
    }

    /// Shadow `range`, citing the events the replacement was made from.
    pub fn replace(range: SeqRange, source_event_seqs: Vec<u64>) -> Self {
        let _ = (range, source_event_seqs);
        todo!("AppendOptions::replace")
    }
}

/// A failure inside the store, kept opaque: the store's own error, boxed.
#[derive(Debug, thiserror::Error)]
#[error("session store: {0}")]
pub struct StoreError(#[source] pub Box<dyn std::error::Error + Send + Sync>);

/// What this crate needs from a session store.
///
/// Every method is synchronous, as the TypeScript store is: an event is on disk before the thing it
/// describes happens. A store is shared across tasks, so it takes `&self`.
pub trait ContextStore: Send + Sync {
    /// What names one open session (`SessionHandle`).
    type Handle: Send + Sync;

    /// How many events the session holds, which is also the next event's seq.
    fn count(&self, session: &Self::Handle) -> Result<u64, StoreError>;

    /// Every event, in order.
    fn read(&self, session: &Self::Handle) -> Result<Vec<LogEvent>, StoreError>;

    /// The surface, folded from the log.
    fn surface(&self, session: &Self::Handle) -> Result<SurfaceState, StoreError>;

    /// The message one node derives to, or `None` when it produces none.
    fn derive_node(&self, session: &Self::Handle, seq: u64) -> Result<Option<Message>, StoreError>;

    /// Append one event — a JSON object whose `type` is set — and return its seq.
    ///
    /// The store adds `seq` and `at` before the event's fields and `surfaceOp` and
    /// `sourceEventSeqs` after them, and validates a replacement before writing anything.
    fn append(
        &self,
        session: &Self::Handle,
        event: Value,
        options: AppendOptions,
    ) -> Result<u64, StoreError>;

    /// The event at `seq`, when there is one.
    fn event(&self, session: &Self::Handle, seq: u64) -> Result<Option<LogEvent>, StoreError> {
        let _ = (session, seq);
        todo!("ContextStore::event")
    }

    /// Every surface node with the message it derives to, in surface order.
    fn derive_surface(&self, session: &Self::Handle) -> Result<Vec<SurfaceNode>, StoreError> {
        let _ = session;
        todo!("ContextStore::derive_surface")
    }

    /// The messages a request carries: every surface node that derives to one, in order
    /// (`deriveMessages`).
    fn derive_messages(&self, session: &Self::Handle) -> Result<Vec<Message>, StoreError> {
        let _ = session;
        todo!("ContextStore::derive_messages")
    }
}
