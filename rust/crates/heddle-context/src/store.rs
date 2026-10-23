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
        self.field("origin").and_then(Value::as_str)
    }

    /// The `identity` a note was rendered from, when it is a string.
    pub fn identity(&self) -> Option<&str> {
        self.field("identity").and_then(Value::as_str)
    }

    /// The `message` a `message` or `context/note` event carries, parsed.
    pub fn message(&self) -> Option<Message> {
        serde_json::from_value(self.field("message")?.clone()).ok()
    }

    /// How the event entered the surface; `None` when it carries no marker (an append, in an old log).
    pub fn surface_op(&self) -> Option<SurfaceOp> {
        self.field("surfaceOp").and_then(SurfaceOp::from_json)
    }
}

impl LogEvent {
    /// This event, borrowed, as a scan reads it.
    pub fn as_ref(&self) -> EventRef<'_> {
        EventRef {
            seq: self.seq,
            kind: &self.kind,
            fields: &self.fields,
        }
    }
}

/// One event of the log, borrowed: what a scan reads without copying the log.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EventRef<'a> {
    /// The event's position in the log.
    pub seq: u64,
    /// The event's `type`.
    pub kind: &'a str,
    /// Every other field as written.
    pub fields: &'a Map<String, Value>,
}

impl<'a> EventRef<'a> {
    /// One field, when present.
    pub fn field(&self, key: &str) -> Option<&'a Value> {
        self.fields.get(key)
    }

    /// The `origin` of a `context/note`.
    pub fn origin(&self) -> Option<&'a str> {
        self.field("origin").and_then(Value::as_str)
    }

    /// The `identity` a note was rendered from, when it is a string.
    pub fn identity(&self) -> Option<&'a str> {
        self.field("identity").and_then(Value::as_str)
    }

    /// Whether this node derives to a system message: a `message` or `context/note` whose message
    /// has the `system` role and at least one part (an empty message derives to none).
    pub fn is_system_message(&self) -> bool {
        if self.kind != "message" && self.kind != "context/note" {
            return false;
        }
        let Some(message) = self.field("message") else {
            return false;
        };
        message.get("role").and_then(Value::as_str) == Some("system")
            && message
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|content| !content.is_empty())
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
        match self {
            SurfaceOp::Append => Value::String("append".to_string()),
            SurfaceOp::Replace(range) => serde_json::json!({
                "op": "replace",
                "startSeq": range.start_seq,
                "endSeq": range.end_seq,
            }),
        }
    }

    /// The operation a log's `surfaceOp` field names, or `None` when it names none.
    pub fn from_json(value: &Value) -> Option<Self> {
        if value.as_str() == Some("append") {
            return Some(SurfaceOp::Append);
        }
        let object = value.as_object()?;
        if object.get("op")?.as_str()? != "replace" {
            return None;
        }
        Some(SurfaceOp::Replace(SeqRange {
            start_seq: object.get("startSeq")?.as_u64()?,
            end_seq: object.get("endSeq")?.as_u64()?,
        }))
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
        Self {
            surface_op: Some(SurfaceOp::Append),
            source_event_seqs: None,
        }
    }

    /// Shadow `range`, citing the events the replacement was made from.
    pub fn replace(range: SeqRange, source_event_seqs: Vec<u64>) -> Self {
        Self {
            surface_op: Some(SurfaceOp::Replace(range)),
            source_event_seqs: Some(source_event_seqs),
        }
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

    /// Visit the log newest first, each event borrowed, until `visit` answers `false`.
    ///
    /// The scans this crate makes — the last call's usage, the retained runtime snapshot, the head
    /// and the baseline — read a few fields of a few events; a store that can lend its events
    /// overrides this so a round never copies the whole log. `visit` must not call the store.
    fn visit_newest_first(
        &self,
        session: &Self::Handle,
        visit: &mut dyn FnMut(EventRef<'_>) -> bool,
    ) -> Result<(), StoreError> {
        for event in self.read(session)?.iter().rev() {
            if !visit(event.as_ref()) {
                break;
            }
        }
        Ok(())
    }

    /// The event at `seq`, when there is one.
    fn event(&self, session: &Self::Handle, seq: u64) -> Result<Option<LogEvent>, StoreError> {
        Ok(self
            .read(session)?
            .into_iter()
            .find(|event| event.seq == seq))
    }

    /// Every surface node with the message it derives to, in surface order.
    fn derive_surface(&self, session: &Self::Handle) -> Result<Vec<SurfaceNode>, StoreError> {
        let nodes = self.surface(session)?.nodes;
        let mut surface = Vec::with_capacity(nodes.len());
        for seq in nodes {
            surface.push(SurfaceNode {
                seq,
                message: self.derive_node(session, seq)?,
            });
        }
        Ok(surface)
    }

    /// The messages a request carries: every surface node that derives to one, in order
    /// (`deriveMessages`).
    fn derive_messages(&self, session: &Self::Handle) -> Result<Vec<Message>, StoreError> {
        Ok(self
            .derive_surface(session)?
            .into_iter()
            .filter_map(|node| node.message)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};

    use super::{LogEvent, SeqRange, SurfaceOp};

    fn event(kind: &str, fields: Value) -> LogEvent {
        let Value::Object(fields) = fields else {
            panic!("fields are an object");
        };
        LogEvent {
            seq: 7,
            kind: kind.to_string(),
            fields,
        }
    }

    #[test]
    fn a_system_message_is_one_with_the_system_role_and_some_content() {
        let system = event(
            "context/note",
            json!({"message": {"role": "system", "content": [{"type": "text", "text": "be brief"}]}, "origin": "system-prompt"}),
        );
        assert!(system.as_ref().is_system_message());
        assert_eq!(system.as_ref().origin(), Some("system-prompt"));

        let empty = event(
            "message",
            json!({"message": {"role": "system", "content": []}}),
        );
        assert!(
            !empty.as_ref().is_system_message(),
            "an empty message derives to none"
        );

        let user = event(
            "message",
            json!({"message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}),
        );
        assert!(!user.as_ref().is_system_message());

        let chunk = event(
            "assistant/chunk",
            json!({"chunk": {"type": "text-delta", "text": "hi"}}),
        );
        assert!(!chunk.as_ref().is_system_message());

        let log_only = event("compaction/start", Value::Object(Map::new()));
        assert!(!log_only.as_ref().is_system_message());
        assert_eq!(log_only.as_ref().seq, 7);
    }

    #[test]
    fn a_surface_operation_round_trips_the_log_spelling() {
        assert_eq!(SurfaceOp::Append.to_json(), json!("append"));
        let replace = SurfaceOp::Replace(SeqRange {
            start_seq: 6,
            end_seq: 3,
        });
        assert_eq!(
            replace.to_json(),
            json!({"op": "replace", "startSeq": 6, "endSeq": 3})
        );
        assert_eq!(SurfaceOp::from_json(&replace.to_json()), Some(replace));
        assert_eq!(
            SurfaceOp::from_json(&json!("append")),
            Some(SurfaceOp::Append)
        );
        assert_eq!(SurfaceOp::from_json(&json!({"op": "insert"})), None);
        assert_eq!(SurfaceOp::from_json(&json!(42)), None);
    }
}
