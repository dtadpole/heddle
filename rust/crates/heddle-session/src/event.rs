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
        match self.fields.get("surfaceOp") {
            None => None,
            Some(Value::String(word)) if word == "append" => Some(SurfaceOp::Append),
            // An object is a replacement when it says `"op": "replace"`; anything else is not one, and
            // the TypeScript fold treats an unreadable marker the same way.
            Some(value @ Value::Object(_)) => serde_json::from_value(value.clone()).ok(),
            Some(_) => None,
        }
    }

    /// Whether this is a live-only event the store published but did not record
    /// (`transient: true`, a tool call's fragment).
    pub fn is_transient(&self) -> bool {
        matches!(self.fields.get("transient"), Some(Value::Bool(true)))
    }

    /// The whole event as one JSON object, in byte order.
    pub fn to_value(&self) -> Value {
        let mut object = Map::with_capacity(self.fields.len() + 3);
        object.insert("seq".to_string(), Value::from(self.seq));
        object.insert("at".to_string(), Value::String(self.at.clone()));
        object.insert("type".to_string(), Value::String(self.kind.clone()));
        for (key, value) in &self.fields {
            object.insert(key.clone(), value.clone());
        }
        Value::Object(object)
    }

    /// The event as one JSONL line, without the newline — exactly what `JSON.stringify` writes.
    pub fn to_line(&self) -> String {
        serde_json::to_string(&self.to_value()).expect("an event is always serializable")
    }

    /// Parse one transcript line.
    pub fn from_line(line: &str) -> Result<SessionEvent, serde_json::Error> {
        serde_json::from_str(line)
    }
}

impl Serialize for SessionEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // The ordered map is what makes the bytes right: `preserve_order` is a feature of this build,
        // so none of `seq`, `at`, `type` or a caller's field moves.
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SessionEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut object = Map::<String, Value>::deserialize(deserializer)?;
        let seq = match object.shift_remove("seq") {
            Some(Value::Number(number)) => number
                .as_u64()
                .ok_or_else(|| D::Error::custom("session event 'seq' is not a whole number"))?,
            _ => return Err(D::Error::custom("session event has no numeric 'seq'")),
        };
        let at = match object.shift_remove("at") {
            Some(Value::String(text)) => text,
            _ => return Err(D::Error::custom("session event has no string 'at'")),
        };
        let kind = match object.shift_remove("type") {
            Some(Value::String(kind)) => kind,
            _ => return Err(D::Error::custom("session event has no string 'type'")),
        };
        Ok(SessionEvent {
            seq,
            at,
            kind,
            fields: object,
        })
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

    /// One field, by its JSON name.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }
}

impl TryFrom<Value> for NewEvent {
    type Error = crate::SessionError;

    /// From a `json!({"type": "…", …})` literal: an object with a string `type`, and no `seq` or `at`.
    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let Value::Object(mut object) = value else {
            return Err(crate::SessionError::MalformedEvent {
                reason: "the event is not a JSON object".to_string(),
            });
        };
        if object.contains_key("seq") || object.contains_key("at") {
            return Err(crate::SessionError::MalformedEvent {
                reason: "'seq' and 'at' are assigned by the store".to_string(),
            });
        }
        let Some(Value::String(kind)) = object.shift_remove("type") else {
            return Err(crate::SessionError::MalformedEvent {
                reason: "'type' is not a string".to_string(),
            });
        };
        Ok(NewEvent {
            kind,
            fields: object,
        })
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
        match self {
            SurfaceOp::Append => serializer.serialize_str("append"),
            SurfaceOp::Replace { start_seq, end_seq } => {
                let mut object = Map::new();
                object.insert("op".to_string(), Value::String("replace".to_string()));
                object.insert("startSeq".to_string(), Value::from(*start_seq));
                object.insert("endSeq".to_string(), Value::from(*end_seq));
                object.serialize(serializer)
            }
        }
    }
}

impl<'de> Deserialize<'de> for SurfaceOp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(word) if word == "append" => Ok(SurfaceOp::Append),
            Value::Object(mut object) => {
                if object.get("op").and_then(Value::as_str) != Some("replace") {
                    return Err(D::Error::custom(
                        "a surface operation is 'append' or a 'replace'",
                    ));
                }
                let start_seq = object
                    .shift_remove("startSeq")
                    .and_then(|value| value.as_u64())
                    .ok_or_else(|| D::Error::custom("a replacement has no numeric 'startSeq'"))?;
                let end_seq = object
                    .shift_remove("endSeq")
                    .and_then(|value| value.as_u64())
                    .ok_or_else(|| D::Error::custom("a replacement has no numeric 'endSeq'"))?;
                Ok(SurfaceOp::Replace { start_seq, end_seq })
            }
            _ => Err(D::Error::custom(
                "a surface operation is 'append' or a 'replace'",
            )),
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, fields: &[(&str, Value)]) -> SessionEvent {
        let mut map = Map::new();
        for (key, value) in fields {
            map.insert((*key).to_string(), value.clone());
        }
        SessionEvent {
            seq: 0,
            at: "2026-10-22T18:17:41.123Z".to_string(),
            kind: kind.to_string(),
            fields: map,
        }
    }

    #[test]
    fn the_bytes_are_what_json_stringify_writes() {
        let created = event("session/created", &[("cwd", json!("/home/me/work"))]);
        assert_eq!(
            created.to_line(),
            r#"{"seq":0,"at":"2026-10-22T18:17:41.123Z","type":"session/created","cwd":"/home/me/work"}"#
        );
    }

    #[test]
    fn the_fields_keep_their_written_order() {
        // A message is written `{ role, toolCallId?, content }`, and the order is part of the contract.
        let message = event(
            "message",
            &[
                (
                    "message",
                    json!({"role": "tool", "toolCallId": "call-1", "content": [{"type": "text", "text": "ok"}]}),
                ),
                ("source", json!({"kind": "goal", "round": 2})),
            ],
        );
        assert_eq!(
            message.to_line(),
            r#"{"seq":0,"at":"2026-10-22T18:17:41.123Z","type":"message","message":{"role":"tool","toolCallId":"call-1","content":[{"type":"text","text":"ok"}]},"source":{"kind":"goal","round":2}}"#
        );
    }

    #[test]
    fn a_line_parses_and_prints_back_unchanged() {
        let line = r#"{"seq":7,"at":"2026-10-22T18:17:41.123Z","type":"assistant/chunk","chunk":{"type":"text-delta","text":"hi"},"surfaceOp":"append"}"#;
        let parsed = SessionEvent::from_line(line).expect("a written line parses");
        assert_eq!(parsed.seq, 7);
        assert_eq!(parsed.kind, "assistant/chunk");
        assert_eq!(parsed.surface_op(), Some(SurfaceOp::Append));
        assert_eq!(parsed.to_line(), line);
    }

    #[test]
    fn a_float_the_typescript_build_wrote_prints_back_unchanged() {
        // `JSON.parse` is correctly rounded, so the TypeScript build reads and rewrites these exactly.
        // serde_json's default float parser lands one ulp off on both (…491 -> …492, …507 -> …508); with
        // `float_roundtrip` it agrees, which is what keeps `heddle transcript` byte-identical.
        let line = r#"{"seq":3,"at":"2026-10-22T18:17:41.123Z","type":"tool/result","score":0.9999551342447491,"ratio":0.9040877429444507}"#;
        let event = SessionEvent::from_line(line).expect("a written line parses");
        assert_eq!(event.to_line(), line);
    }

    #[test]
    fn a_line_that_is_not_an_event_is_an_error() {
        assert!(SessionEvent::from_line("not json").is_err());
        assert!(
            SessionEvent::from_line(r#"{"seq":0,"at":"x"}"#).is_err(),
            "no type"
        );
        assert!(
            SessionEvent::from_line(r#"{"at":"2026-10-22T18:17:41.123Z","type":"x"}"#).is_err(),
            "no seq"
        );
    }

    #[test]
    fn a_replacement_round_trips_in_the_typescript_shape() {
        let op = SurfaceOp::Replace {
            start_seq: 5,
            end_seq: 9,
        };
        let text = serde_json::to_string(&op).unwrap();
        assert_eq!(text, r#"{"op":"replace","startSeq":5,"endSeq":9}"#);
        assert_eq!(serde_json::from_str::<SurfaceOp>(&text).unwrap(), op);
        assert_eq!(
            serde_json::to_string(&SurfaceOp::Append).unwrap(),
            r#""append""#
        );
        assert_eq!(
            serde_json::from_str::<SurfaceOp>(r#""append""#).unwrap(),
            SurfaceOp::Append
        );
    }

    #[test]
    fn an_event_carries_its_replacement_as_a_field() {
        let mut replacement = event(
            "message",
            &[("message", json!({"role": "user", "content": []}))],
        );
        replacement.fields.insert(
            "surfaceOp".to_string(),
            json!({"op": "replace", "startSeq": 2, "endSeq": 4}),
        );
        assert_eq!(
            replacement.surface_op(),
            Some(SurfaceOp::Replace {
                start_seq: 2,
                end_seq: 4
            })
        );
        assert_eq!(
            replacement.to_line(),
            r#"{"seq":0,"at":"2026-10-22T18:17:41.123Z","type":"message","message":{"role":"user","content":[]},"surfaceOp":{"op":"replace","startSeq":2,"endSeq":4}}"#
        );
    }

    #[test]
    fn a_marker_that_is_not_a_replacement_is_not_one() {
        let plain = event("message", &[("surfaceOp", json!("append"))]);
        assert_eq!(plain.surface_op(), Some(SurfaceOp::Append));
        let odd = event("message", &[("surfaceOp", json!({"op": "other"}))]);
        assert_eq!(odd.surface_op(), None);
        let absent = event("message", &[]);
        assert_eq!(absent.surface_op(), None);
    }

    #[test]
    fn a_transient_event_says_so() {
        let transient = event("assistant/chunk", &[("transient", json!(true))]);
        assert!(transient.is_transient());
        let recorded = event("assistant/chunk", &[]);
        assert!(!recorded.is_transient());
    }

    #[test]
    fn a_new_event_is_built_from_a_json_object() {
        let parsed = NewEvent::try_from(json!({"type": "turn/completed", "round": 1}))
            .expect("a well-formed event");
        assert_eq!(parsed.kind, "turn/completed");
        assert_eq!(parsed.get("round"), Some(&json!(1)));

        for bad in [
            json!(["type"]),
            json!({"round": 1}),
            json!({"type": 7}),
            json!({"type": "x", "seq": 3}),
            json!({"type": "x", "at": "2026-10-22T18:17:41.123Z"}),
        ] {
            assert!(NewEvent::try_from(bad.clone()).is_err(), "refused: {bad}");
        }
    }

    #[test]
    fn the_builder_appends_in_call_order() {
        let built = NewEvent::new("turn/retry")
            .field("round", 2)
            .field("attempt", 1);
        let event = SessionEvent {
            seq: 0,
            at: "2026-10-22T18:17:41.123Z".to_string(),
            kind: built.kind,
            fields: built.fields,
        };
        assert_eq!(
            event.to_line(),
            r#"{"seq":0,"at":"2026-10-22T18:17:41.123Z","type":"turn/retry","round":2,"attempt":1}"#
        );
    }
}
