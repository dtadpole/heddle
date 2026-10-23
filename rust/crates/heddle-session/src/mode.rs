//! A session's access mode, recorded as one append-only `permission/mode` event.
//!
//! Ported from `src/session/mode.ts`. DSH keeps `sandbox/mode` as a log-only event folded over the
//! deployment default; this is the same mechanism with heddle's names. The event takes no surface
//! position, so it never reaches a model as conversation.
//!
//! # The vocabulary is the sandbox's
//!
//! The fold is one rule — the last event wins, and a recorded word outside the vocabulary is an error
//! naming the event — and it lives here, beside the log. The vocabulary (`read-only`,
//! `workspace-write`, `danger-full-access`) is `heddle-sandbox`'s, so these functions are generic over
//! the mode type and read and write it **through serde**: the event's `mode` field is deserialized into
//! `M` (a word the type refuses is the error) and `M` is serialized into it. `heddle-sandbox`'s
//! `SandboxMode` (`Serialize + Deserialize`, kebab-case) fits as it is, the session crate does not depend
//! on the sandbox, and there is still one list of modes.

use std::borrow::Borrow;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::SessionError;
use crate::event::{NewEvent, SessionEvent, SessionHandle};
use crate::store::SessionStore;

/// The event type one mode change appends: `{"type":"permission/mode","mode":"<word>"}`.
pub const MODE_EVENT: &str = "permission/mode";

/// The mode a log records, or `None` when it records none.
///
/// The last `permission/mode` event wins. Its `mode` must deserialize into `M`; anything else —
/// another word, a number, no field — is [`SessionError::UnknownRecordedMode`] naming the event's seq,
/// because falling back to the default would run a session under a policy nobody chose and make a
/// corrupt log look healthy.
pub fn recorded_mode<M, E>(events: &[E]) -> Result<Option<M>, SessionError>
where
    M: DeserializeOwned,
    E: Borrow<SessionEvent>,
{
    for event in events.iter().rev() {
        let event = event.borrow();
        if event.kind != MODE_EVENT {
            continue;
        }
        match event.get("mode") {
            Some(value) => match serde_json::from_value::<M>(value.clone()) {
                Ok(mode) => return Ok(Some(mode)),
                Err(_) => {
                    return Err(SessionError::UnknownRecordedMode {
                        seq: event.seq,
                        word: javascript_string(Some(value)),
                    });
                }
            },
            None => {
                return Err(SessionError::UnknownRecordedMode {
                    seq: event.seq,
                    word: javascript_string(None),
                });
            }
        }
    }
    Ok(None)
}

/// The mode a call runs under: the log's last record, else `fallback` (the deployment default).
pub fn effective_mode<M, E>(events: &[E], fallback: M) -> Result<M, SessionError>
where
    M: DeserializeOwned,
    E: Borrow<SessionEvent>,
{
    Ok(recorded_mode(events)?.unwrap_or(fallback))
}

/// Give a child session the mode its parent runs under, at creation.
///
/// Delegation must not widen access as a side effect: without this a child of a `read-only` parent would
/// run under the deployment default. A parent that recorded no mode gives nothing, because it is itself
/// running under that default. Answers with the inherited mode.
pub fn inherit_recorded_mode<M>(
    store: &SessionStore,
    parent: &SessionHandle,
    child: &SessionHandle,
) -> Result<Option<M>, SessionError>
where
    M: Serialize + DeserializeOwned,
{
    let mode: Option<M> = recorded_mode(store.read(parent)?.as_slice())?;
    if let Some(mode) = &mode {
        store.append(
            child,
            NewEvent::new(MODE_EVENT).field(
                "mode",
                serde_json::to_value(mode).expect("a mode is serializable"),
            ),
            Default::default(),
        )?;
    }
    Ok(mode)
}

/// The field as JavaScript's `String()` would print it — `undefined` when the field is absent, which is
/// the word the TypeScript error carries for an event that records no mode at all.
fn javascript_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Array(_)) => "[object Array]".to_string(),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Map;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    enum Mode {
        ReadOnly,
        WorkspaceWrite,
        DangerFullAccess,
    }

    fn mode_event(seq: u64, mode: Option<Value>) -> SessionEvent {
        let mut fields = Map::new();
        if let Some(mode) = mode {
            fields.insert("mode".to_string(), mode);
        }
        SessionEvent {
            seq,
            at: "2026-10-22T18:17:41.123Z".to_string(),
            kind: MODE_EVENT.to_string(),
            fields,
        }
    }

    #[test]
    fn the_last_recorded_mode_wins() {
        let events = vec![
            mode_event(0, Some(Value::String("read-only".to_string()))),
            SessionEvent {
                seq: 1,
                at: "2026-10-22T18:17:41.123Z".to_string(),
                kind: "message".to_string(),
                fields: Map::new(),
            },
            mode_event(2, Some(Value::String("workspace-write".to_string()))),
        ];
        assert_eq!(
            recorded_mode::<Mode, _>(&events).unwrap(),
            Some(Mode::WorkspaceWrite)
        );
    }

    #[test]
    fn a_log_with_no_mode_records_none_and_takes_the_fallback() {
        let events: Vec<SessionEvent> = Vec::new();
        assert_eq!(recorded_mode::<Mode, _>(&events).unwrap(), None);
        assert_eq!(
            effective_mode(&events, Mode::DangerFullAccess).unwrap(),
            Mode::DangerFullAccess
        );
    }

    #[test]
    fn a_word_outside_the_vocabulary_is_an_error_naming_the_event() {
        let events = vec![mode_event(7, Some(Value::String("yolo".to_string())))];
        let error = recorded_mode::<Mode, _>(&events).unwrap_err();
        assert_eq!(
            error.to_string(),
            "session event 7 records access mode 'yolo', which is not one of the sandbox modes"
        );
    }

    #[test]
    fn a_mode_event_with_no_mode_names_the_word_undefined() {
        let events = vec![mode_event(3, None)];
        let error = recorded_mode::<Mode, _>(&events).unwrap_err();
        assert_eq!(
            error.to_string(),
            "session event 3 records access mode 'undefined', which is not one of the sandbox modes"
        );
    }

    #[test]
    fn a_child_inherits_its_parents_mode() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_str().unwrap(), &heddle_config::Env::default());
        let parent = store.create(Default::default()).unwrap();
        let child = store.create(Default::default()).unwrap();
        // A parent that recorded nothing gives nothing.
        assert_eq!(
            inherit_recorded_mode::<Mode>(&store, &parent, &child).unwrap(),
            None
        );
        assert_eq!(store.count(&child).unwrap(), 1);

        store
            .append(
                &parent,
                NewEvent::new(MODE_EVENT).field("mode", Value::String("read-only".to_string())),
                Default::default(),
            )
            .unwrap();
        assert_eq!(
            inherit_recorded_mode::<Mode>(&store, &parent, &child).unwrap(),
            Some(Mode::ReadOnly)
        );
        assert_eq!(
            recorded_mode::<Mode, _>(store.read(&child).unwrap().as_slice()).unwrap(),
            Some(Mode::ReadOnly)
        );
    }
}
