//! One entry in the log, the handle a caller holds, and how an event enters the surface.
//!
//! Ported from the types at the top of `src/session/store.ts`.
//!
//! # Byte order of an event
//!
//! The TypeScript store writes `{ seq, at, ...event, surfaceOp?, sourceEventSeqs? }` with
//! `JSON.stringify`, and every caller there builds `event` with `type` first. A [`SessionEvent`]
//! therefore serializes `seq`, `at`, `type`, then its other fields **in the order they were given** (an
//! ordered map), then `surfaceOp` and `sourceEventSeqs` when the append set them — the same bytes. Read
//! back, the fields keep the order they were written in, so a log copied through this crate is unchanged.

use std::sync::Arc;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

/// Identifies one session: `session-<uuid>` for a generated one, and the file name of its log.
pub type SessionId = String;

/// One entry in the log. `seq` is its position: 0 for `session/created`, then monotonic, no holes.
///
/// Every field other than the three every event has lives in [`SessionEvent::fields`], in written
/// order — including `surfaceOp` and `sourceEventSeqs`, which [`SessionEvent::surface_op`] reads.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionEvent {
    pub seq: u64,
    /// When it was appended, as `toISOString` prints it.
    pub at: String,
    /// The event type: `message`, `assistant/chunk`, `turn/completed`, `permission/mode`, …
    pub kind: String,
    /// Everything else, in written order.
    pub fields: Map<String, Value>,
}

impl SessionEvent {
    /// One field, by its JSON name.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }

    /// How this event entered the surface: `None` for an event with no marker (an append, in an older
    /// log as much as a new one).
    pub fn surface_op(&self) -> Option<SurfaceOp> {
        todo!()
    }

    /// Whether this is a live-only event the store published but did not record
    /// (`transient: true`, a tool call's fragment).
    pub fn is_transient(&self) -> bool {
        todo!()
    }

    /// The whole event as one JSON object, in byte order.
    pub fn to_value(&self) -> Value {
        todo!()
    }

    /// The event as one JSONL line, without the newline — exactly what `JSON.stringify` writes.
    pub fn to_line(&self) -> String {
        todo!()
    }

    /// Parse one transcript line.
    pub fn from_line(line: &str) -> Result<SessionEvent, serde_json::Error> {
        todo!()
    }
}

impl Serialize for SessionEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        todo!("seq, at, type, then fields in order")
    }
}

impl<'de> Deserialize<'de> for SessionEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let object = Map::<String, Value>::deserialize(deserializer)?;
        let _ = object;
        Err(D::Error::custom(
            "todo: SessionEvent deserialization is not ported yet",
        ))
    }
}

/// The events of one session, as the store holds them: shared, cheap to clone, never mutated in place.
///
/// A snapshot — an append after it was taken is not in it. The TypeScript store handed out its own
/// array; this hands out an `Arc` of it, so a caller reads without copying and an append does not have to
/// wait for a reader to finish.
pub type Events = Arc<Vec<Arc<SessionEvent>>>;

/// An event a caller wants appended: its type and its fields, in the order they should be written.
///
/// `seq` and `at` are the store's to assign; an event that carries either is refused.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NewEvent {
    pub kind: String,
    pub fields: Map<String, Value>,
}

impl NewEvent {
    /// An event of this type with no fields yet.
    pub fn new(kind: impl Into<String>) -> Self {
        NewEvent {
            kind: kind.into(),
            fields: Map::new(),
        }
    }

    /// Add one field after the ones already given. Builder-style, so a call site reads like the
    /// TypeScript object literal: `NewEvent::new("turn/retry").field("round", 2).field("attempt", 1)`.
    pub fn field(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.fields.insert(key.into(), value.into());
        self
    }
}

impl TryFrom<Value> for NewEvent {
    type Error = crate::SessionError;

    /// From a `json!({"type": "…", …})` literal: an object with a string `type`, and no `seq` or `at`.
    fn try_from(value: Value) -> Result<Self, Self::Error> {
        todo!()
    }
}

/// What a caller gets back when it opens a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionHandle {
    pub id: SessionId,
    /// The folder this session's files are in: its workspace folder, or its own directory in the old layout.
    pub dir: String,
    /// Where the transcript is; a caller may cite it.
    pub transcript: String,
    /// Where the metadata is: `<id>.json` beside the log, or `meta.json` inside the old session directory.
    pub meta: String,
}

/// How an event entered the surface.
///
/// Serialized as the TypeScript build writes it: the string `"append"`, or
/// `{"op":"replace","startSeq":…,"endSeq":…}`. A replacement names **positions**: `start_seq` and
/// `end_seq` are the seqs of the first and last node of the span as it stands on the surface, and
/// `start_seq` may be greater than `end_seq` after an earlier replacement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceOp {
    Append,
    Replace { start_seq: u64, end_seq: u64 },
}

impl Serialize for SurfaceOp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        todo!()
    }
}

impl<'de> Deserialize<'de> for SurfaceOp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let _ = value;
        Err(D::Error::custom(
            "todo: SurfaceOp deserialization is not ported yet",
        ))
    }
}

/// The options of one append.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppendOptions {
    /// Leave `None` for the ordinary case. `Some(Append)` writes `"surfaceOp":"append"`; a `Replace`
    /// shadows a span and is validated before anything is written.
    pub surface_op: Option<SurfaceOp>,
    /// The seqs an event was derived from (a compaction summary names what it summarises).
    pub source_event_seqs: Option<Vec<u64>>,
}
