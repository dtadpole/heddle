//! The session's pending input: what a person sent into a running turn that the turn has not taken yet.
//!
//! A port of `src/session/inbox.ts`, which is DSH's agent inbox (`dsh-agent-loop`, `ReactLoopInbox`)
//! recorded the way DSH records it. A steer does not write a message. It splices the message into the
//! **next-step** list, and the loop claims the whole list at its next step boundary. A tool call's result
//! is written inside the step that asked for it, so the steered message lands after that result and never
//! between a call and its answer. A stop leaves the list as it is, because DSH's session cancel keeps the
//! inbox (`agent.cancel({ kind: "user" }, { keepInbox: true })`). The next turn claims what is left before
//! its own prompt, as DSH's boundary claims next-step input first.
//!
//! The list is **durable**. Every change is one `agent/inbox/spliced` event with DSH's fields (`target`,
//! `start`, `removedCount`, `inserted`, `outcome`), and the state is the fold of those events. So a pending
//! steer survives a restart, and every reader of the log sees the same list. Measured before this module
//! existed (R-developer-two-5): a steer sent during `bash sleep 30` was written between the call and its
//! result, and a stop then left nothing pending.
//!
//! heddle's page keeps its own next-turn queue, so only `next-step` is written here. The fold still reads
//! both lists, so a later queue on the server can use the same event.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    AppendOptions, ContentPart, NewEvent, SessionError, SessionEvent, SessionHandle, SessionStore,
};

/// The event every inbox change is recorded as. DSH's name.
pub const INBOX_SPLICED: &str = "agent/inbox/spliced";

/// The list a steer goes to: input for the next step of the running turn.
pub const NEXT_STEP: &str = "next-step";

/// The list of prompts that each start a turn. heddle writes none yet; the fold reads it.
pub const NEXT_TURN: &str = "next-turn";

/// One pending message. It is written as an ordinary user message when it is claimed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxMessage {
    pub id: String,
    /// Always `user`.
    pub role: String,
    pub content: Vec<ContentPart>,
    /// Who wrote it, when it was not a person (the same field a recorded message carries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

/// The inbox's state: DSH's projection, `{"next-turn": [...], "next-step": [...]}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Inbox {
    #[serde(rename = "next-turn")]
    pub next_turn: Vec<InboxMessage>,
    #[serde(rename = "next-step")]
    pub next_step: Vec<InboxMessage>,
}

/// Why the inbox could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum InboxError {
    /// The log could not be read or appended to.
    #[error(transparent)]
    Session(#[from] SessionError),
    /// `invalid persisted inbox splice at session seq <seq>: <reason>` — DSH's sentence.
    #[error("invalid persisted inbox splice at session seq {seq}: {reason}")]
    Invalid { seq: u64, reason: String },
}

/// Fold the inbox from a session's events.
///
/// An invalid splice is refused the way DSH refuses it. That covers a start or count outside the list and
/// a message id that is already pending. The error names the seq, because a log that carries one cannot be
/// read as a list of pending input.
pub fn fold_inbox<'a>(
    events: impl IntoIterator<Item = &'a SessionEvent>,
) -> Result<Inbox, InboxError> {
    let mut state = Inbox::default();
    for event in events {
        if event.kind != INBOX_SPLICED {
            continue;
        }
        apply(&mut state, &event.fields).map_err(|reason| InboxError::Invalid {
            seq: event.seq,
            reason,
        })?;
    }
    Ok(state)
}

/// [`fold_inbox`] over events read as JSON objects (`{"seq", "type", ...}`), the form a server's views hold.
pub fn fold_inbox_values<'a>(
    events: impl IntoIterator<Item = &'a Value>,
) -> Result<Inbox, InboxError> {
    let mut state = Inbox::default();
    for event in events {
        let Some(object) = event.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some(INBOX_SPLICED) {
            continue;
        }
        apply(&mut state, object).map_err(|reason| InboxError::Invalid {
            seq: object
                .get("seq")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            reason,
        })?;
    }
    Ok(state)
}

fn apply(state: &mut Inbox, splice: &Map<String, Value>) -> Result<(), String> {
    let target = splice
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let list = match target {
        NEXT_TURN => &state.next_turn,
        NEXT_STEP => &state.next_step,
        other => return Err(format!("unknown inbox target {other:?}")),
    };
    let start = splice.get("start").and_then(Value::as_u64);
    let removed = match splice.get("removedCount") {
        None => Some(0),
        Some(value) => value.as_u64(),
    };
    let (Some(start), Some(removed)) = (start, removed) else {
        return Err("invalid inbox splice".to_string());
    };
    let (start, removed) = (start as usize, removed as usize);
    if start > list.len() || start + removed > list.len() {
        return Err("invalid inbox splice".to_string());
    }
    let inserted: Vec<InboxMessage> = match splice.get("inserted") {
        None => Vec::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| error.to_string())?,
    };
    let mut next = list[..start].to_vec();
    next.extend(inserted);
    next.extend_from_slice(&list[start + removed..]);
    let other = if target == NEXT_TURN {
        &state.next_step
    } else {
        &state.next_turn
    };
    let mut ids = HashSet::new();
    for message in next.iter().chain(other.iter()) {
        if !ids.insert(message.id.as_str()) {
            return Err(format!("message {:?} is already pending", message.id));
        }
    }
    if target == NEXT_TURN {
        state.next_turn = next;
    } else {
        state.next_step = next;
    }
    Ok(())
}

/// The session's inbox now.
pub fn pending_inbox(store: &SessionStore, handle: &SessionHandle) -> Result<Inbox, InboxError> {
    let events = store.read(handle)?;
    fold_inbox(events.iter().map(|event| event.as_ref()))
}

/// Whether a message waits for the next step boundary. The loop asks this before it ends a turn.
pub fn has_pending_step(store: &SessionStore, handle: &SessionHandle) -> Result<bool, InboxError> {
    Ok(!pending_inbox(store, handle)?.next_step.is_empty())
}

/// The steer gate (#31): the sessions whose running turn still accepts a steer.
///
/// A turn opens it when it begins and closes it in the same critical section as its final "nothing pending"
/// decision ([`has_pending_step_or_close`]); [`queue_steer_if_open`] checks it and appends under the same lock.
/// So no steer is queued after the loop stopped looking and before the turn ends. Measured window before
/// (developer-ten's review): a steer accepted between the loop's last check and the server's running count
/// dropping waited in the inbox until the person sent something else. In memory only, keyed by session id (a
/// gate belongs to a live turn of this process). `steerGates` in `src/session/inbox.ts` is the twin; it is kept
/// per store, this one is global by design, which is the same because session ids are UUIDs (developer-eight's
/// review). The one lock serializes gate checks across sessions, which is cheap at today's volume; a per-session
/// lock would keep the same guarantee if it ever matters.
static STEER_GATES: std::sync::Mutex<std::collections::BTreeSet<String>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

fn steer_gates() -> std::sync::MutexGuard<'static, std::collections::BTreeSet<String>> {
    STEER_GATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A turn began on the session: steers are accepted until it ends.
pub fn open_steering(handle: &SessionHandle) {
    steer_gates().insert(handle.id.clone());
}

/// The turn ended, whichever way: a steer now waits for a turn of its own.
pub fn close_steering(handle: &SessionHandle) {
    steer_gates().remove(&handle.id);
}

/// Whether a steer sent now would still be claimed by the running turn.
pub fn steering_open(handle: &SessionHandle) -> bool {
    steer_gates().contains(&handle.id)
}

/// The loop's end-of-turn question: `true` when a message waits for the next step; otherwise the gate closes
/// under the same lock a steer is queued under, and the answer is `false`.
pub fn has_pending_step_or_close(
    store: &SessionStore,
    handle: &SessionHandle,
) -> Result<bool, InboxError> {
    let mut gates = steer_gates();
    if has_pending_step(store, handle)? {
        return Ok(true);
    }
    gates.remove(&handle.id);
    Ok(false)
}

/// [`queue_steer`] while the session's turn still accepts a steer; `None` when the gate is shut, which the
/// route answers as `session/steer-unavailable`.
pub fn queue_steer_if_open(
    store: &SessionStore,
    handle: &SessionHandle,
    content: Vec<ContentPart>,
    source: Option<Value>,
) -> Result<Option<InboxMessage>, InboxError> {
    let gates = steer_gates();
    if !gates.contains(&handle.id) {
        return Ok(None);
    }
    let queued = queue_steer(store, handle, content, source)?;
    drop(gates);
    Ok(Some(queued))
}

/// Steer: put a message at the end of the next-step list (DSH's `steer`, `send(message, "next-step", true)`).
///
/// Nothing reaches the conversation here. The running loop writes the message at its next step boundary,
/// which is after the result of any tool call still running.
pub fn queue_steer(
    store: &SessionStore,
    handle: &SessionHandle,
    content: Vec<ContentPart>,
    source: Option<Value>,
) -> Result<InboxMessage, InboxError> {
    let message = InboxMessage {
        id: format!("inbox-{}", uuid::Uuid::new_v4()),
        role: "user".to_string(),
        content,
        source,
    };
    let start = pending_inbox(store, handle)?.next_step.len();
    let inserted =
        serde_json::to_value(std::slice::from_ref(&message)).expect("a message is serializable");
    store.append(
        handle,
        NewEvent::new(INBOX_SPLICED)
            .field("target", NEXT_STEP)
            .field("start", start as u64)
            .field("inserted", inserted),
        AppendOptions::default(),
    )?;
    Ok(message)
}

/// Claim the whole next-step list at a step boundary and write each message into the conversation.
///
/// DSH's order: the claim is recorded first (a splice that removes the list, with no `outcome`, because the
/// messages are delivered rather than cancelled), then each message is written as a user message in list
/// order. `write` is the session's own user-message path, so a claimed steer is the same event a typed
/// prompt is. Answers the messages claimed, which is none when nothing waited.
pub fn claim_next_step(
    store: &SessionStore,
    handle: &SessionHandle,
    mut write: impl FnMut(Vec<ContentPart>, Option<Value>) -> Result<(), SessionError>,
) -> Result<Vec<InboxMessage>, InboxError> {
    let claimed = pending_inbox(store, handle)?.next_step;
    if claimed.is_empty() {
        return Ok(claimed);
    }
    store.append(
        handle,
        NewEvent::new(INBOX_SPLICED)
            .field("target", NEXT_STEP)
            .field("start", 0u64)
            .field("removedCount", claimed.len() as u64)
            .field("inserted", Value::Array(Vec::new())),
        AppendOptions::default(),
    )?;
    for message in &claimed {
        write(message.content.clone(), message.source.clone())?;
    }
    Ok(claimed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CreateOptions;
    use serde_json::json;

    fn event(seq: u64, value: Value) -> SessionEvent {
        let Value::Object(mut fields) = value else {
            panic!("an object")
        };
        let kind = fields
            .remove("type")
            .and_then(|kind| kind.as_str().map(str::to_string))
            .expect("a type");
        SessionEvent {
            seq,
            at: String::new(),
            kind,
            fields,
        }
    }

    fn item(id: &str) -> Value {
        json!({"id": id, "role": "user", "content": [{"type": "text", "text": id}]})
    }

    fn ids(list: &[InboxMessage]) -> Vec<&str> {
        list.iter().map(|message| message.id.as_str()).collect()
    }

    fn splices() -> Vec<SessionEvent> {
        vec![
            event(
                1,
                json!({"type": INBOX_SPLICED, "target": "next-step", "start": 0, "inserted": [item("a")]}),
            ),
            event(
                2,
                json!({"type": "message", "message": {"role": "user", "content": []}}),
            ),
            event(
                3,
                json!({"type": INBOX_SPLICED, "target": "next-step", "start": 1, "inserted": [item("b")]}),
            ),
            event(
                4,
                json!({"type": INBOX_SPLICED, "target": "next-turn", "start": 0, "inserted": [item("c")]}),
            ),
            event(
                5,
                json!({"type": INBOX_SPLICED, "target": "next-step", "start": 0, "removedCount": 1, "inserted": []}),
            ),
        ]
    }

    #[test]
    fn the_inbox_folds_dsh_splices_into_its_two_lists() {
        let inbox = fold_inbox(splices().iter()).expect("a valid history");
        assert_eq!(ids(&inbox.next_step), ["b"]);
        assert_eq!(ids(&inbox.next_turn), ["c"]);
        assert_eq!(
            serde_json::to_value(&inbox).unwrap()["next-step"][0]["content"],
            json!([{"type": "text", "text": "b"}]),
            "the view's shape is DSH's projection"
        );
    }

    #[test]
    fn the_json_fold_reads_the_same_lists_as_the_event_fold() {
        let values: Vec<Value> = splices()
            .iter()
            .map(|event| {
                let mut object = Map::new();
                object.insert("seq".into(), json!(event.seq));
                object.insert("type".into(), json!(event.kind));
                object.extend(event.fields.clone());
                Value::Object(object)
            })
            .collect();
        assert_eq!(
            fold_inbox_values(values.iter()).expect("a valid history"),
            fold_inbox(splices().iter()).expect("a valid history")
        );
    }

    #[test]
    fn an_invalid_splice_is_refused_by_its_seq() {
        let mut out_of_range = splices();
        out_of_range.push(event(
            6,
            json!({"type": INBOX_SPLICED, "target": "next-step", "start": 0, "removedCount": 2, "inserted": []}),
        ));
        let error = fold_inbox(out_of_range.iter()).expect_err("a count past the list");
        assert!(
            error
                .to_string()
                .starts_with("invalid persisted inbox splice at session seq 6"),
            "{error}"
        );

        let mut duplicate = splices();
        duplicate.push(event(7, json!({"type": INBOX_SPLICED, "target": "next-step", "start": 0, "inserted": [item("c")]})));
        let error = fold_inbox(duplicate.iter()).expect_err("an id already pending");
        assert!(
            error
                .to_string()
                .starts_with("invalid persisted inbox splice at session seq 7"),
            "{error}"
        );
    }

    #[test]
    fn the_steer_gate_shuts_at_the_final_nothing_pending_decision_and_refuses_a_later_steer() {
        // #31: the loop's last check and the gate's close are one critical section, so a steer is either claimed
        // by the running turn or refused (409), never accepted and left waiting.
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_str().unwrap(), &heddle_config::Env::default());
        let handle = store.create(CreateOptions::default()).expect("a session");
        let text = |text: &str| {
            vec![ContentPart::Text {
                text: text.to_string(),
            }]
        };
        assert!(!steering_open(&handle), "no turn, no steering");
        assert!(
            queue_steer_if_open(&store, &handle, text("early"), None)
                .expect("reads")
                .is_none(),
            "a shut gate queues nothing"
        );
        open_steering(&handle);
        let queued = queue_steer_if_open(
            &store,
            &handle,
            text("one more thing"),
            Some(serde_json::json!({ "kind": "steer", "steerId": "steer-1" })),
        )
        .expect("reads");
        assert!(queued.is_some(), "an open gate queues the steer");
        assert!(
            has_pending_step_or_close(&store, &handle).expect("reads"),
            "a waiting steer keeps the turn going"
        );
        assert!(steering_open(&handle), "and the gate open");
        claim_next_step(&store, &handle, |_, _| Ok(())).expect("claims");
        assert!(
            !has_pending_step_or_close(&store, &handle).expect("reads"),
            "nothing waits: the turn ends"
        );
        assert!(
            !steering_open(&handle),
            "and the gate shut in the same call"
        );
        assert!(
            queue_steer_if_open(&store, &handle, text("too late"), None)
                .expect("reads")
                .is_none(),
            "so a later steer is refused"
        );
        open_steering(&handle);
        close_steering(&handle);
        assert!(
            !steering_open(&handle),
            "a turn that ends any other way shuts it too"
        );
    }

    #[test]
    fn a_steer_is_one_splice_and_a_claim_records_the_removal_before_writing_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_str().unwrap(), &heddle_config::Env::default());
        let handle = store.create(CreateOptions::default()).expect("a session");
        let text = |text: &str| {
            vec![ContentPart::Text {
                text: text.to_string(),
            }]
        };

        let mut written: Vec<String> = Vec::new();
        let nothing = claim_next_step(&store, &handle, |_, _| unreachable!("nothing waits"))
            .expect("a claim");
        assert!(nothing.is_empty(), "an empty inbox claims nothing");

        let before = store.count(&handle).expect("a count");
        queue_steer(&store, &handle, text("first"), None).expect("queued");
        queue_steer(
            &store,
            &handle,
            text("second"),
            Some(json!({"kind": "team-message", "messageId": "m1"})),
        )
        .expect("queued");
        assert_eq!(
            store.count(&handle).expect("a count"),
            before + 2,
            "a steer is one splice event and no message"
        );
        assert!(has_pending_step(&store, &handle).expect("readable"));

        let claimed = claim_next_step(&store, &handle, |content, source| {
            written.push(crate::text_of(&content));
            store
                .message(
                    &handle,
                    crate::Message {
                        role: crate::Role::User,
                        tool_call_id: None,
                        content,
                        source,
                    },
                )
                .map(|_| ())
        })
        .expect("a claim");
        assert_eq!(written, ["first", "second"]);
        assert_eq!(
            claimed[1].source,
            Some(json!({"kind": "team-message", "messageId": "m1"}))
        );
        let events = store.read(&handle).expect("readable");
        let tail: Vec<&SessionEvent> = events
            .iter()
            .skip(before as usize + 2)
            .map(|event| event.as_ref())
            .collect();
        assert_eq!(
            tail[0].kind, INBOX_SPLICED,
            "the claim is recorded before the messages"
        );
        assert_eq!(tail[0].fields.get("removedCount"), Some(&json!(2)));
        assert_eq!(
            tail[0].fields.get("outcome"),
            None,
            "a claim delivers, it does not cancel"
        );
        assert_eq!(
            tail[1..]
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            ["message", "message"]
        );
        assert!(
            !has_pending_step(&store, &handle).expect("readable"),
            "nothing is left pending"
        );
    }
}
