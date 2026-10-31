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
//! heddle's page keeps its own next-turn queue, so a steer is the only input that waits here between turns.
//! `next-turn` is written by one path: a turn into an archived session queues its prompt and its rejected step
//! claims it at once ([`queue_turn`], [`claim_rejected`]), so the log records the dropped input the way DSH's does.

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

/// The list of prompts that each start a turn; written only by a turn into an archived session.
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

/// Queue a prompt as the next turn's input (DSH's `followup`, `inbox.append("next-turn", message)`).
///
/// heddle writes a prompt straight into the conversation when its turn starts, so this list is used only where
/// DSH's order has to be kept: a turn into an archived session queues its prompt here, and the rejected step
/// claims and drops it ([`claim_rejected`]), which is how DSH records input it discarded. `queueTurn` in the
/// TypeScript build.
pub fn queue_turn(
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
    let start = pending_inbox(store, handle)?.next_turn.len();
    let inserted =
        serde_json::to_value(std::slice::from_ref(&message)).expect("a message is serializable");
    store.append(
        handle,
        NewEvent::new(INBOX_SPLICED)
            .field("target", NEXT_TURN)
            .field("start", start as u64)
            .field("inserted", inserted),
        AppendOptions::default(),
    )?;
    Ok(message)
}

/// Claim what a step proposes and write **none** of it: the claim of a step the archived-session gate rejected.
///
/// DSH's `claim(target)` takes the whole next-step list and, at a turn's first step (`with_turn`), the first
/// queued prompt; each is one splice with no `outcome`, because a claim delivers to the step. The gate then
/// rejects the step, so the claimed messages are never written: "the pre-step rejection that produced it
/// discarded the claimed messages" (dsh-agent lib/index.js:53-62). Answers what was claimed. `claimRejected` in
/// the TypeScript build.
pub fn claim_rejected(
    store: &SessionStore,
    handle: &SessionHandle,
    with_turn: bool,
) -> Result<Vec<InboxMessage>, InboxError> {
    let inbox = pending_inbox(store, handle)?;
    let mut claimed = Vec::new();
    if !inbox.next_step.is_empty() {
        store.append(
            handle,
            NewEvent::new(INBOX_SPLICED)
                .field("target", NEXT_STEP)
                .field("start", 0u64)
                .field("removedCount", inbox.next_step.len() as u64)
                .field("inserted", Value::Array(Vec::new())),
            AppendOptions::default(),
        )?;
        claimed.extend(inbox.next_step);
    }
    if with_turn && let Some(queued) = inbox.next_turn.into_iter().next() {
        store.append(
            handle,
            NewEvent::new(INBOX_SPLICED)
                .field("target", NEXT_TURN)
                .field("start", 0u64)
                .field("removedCount", 1u64)
                .field("inserted", Value::Array(Vec::new())),
            AppendOptions::default(),
        )?;
        claimed.push(queued);
    }
    Ok(claimed)
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

    #[test]
    fn a_rejected_claim_records_dshs_splices_and_writes_no_message() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_str().unwrap(), &heddle_config::Env::default());
        let handle = store.create(CreateOptions::default()).expect("a session");
        let text = |text: &str| {
            vec![ContentPart::Text {
                text: text.to_string(),
            }]
        };
        let base = store.count(&handle).expect("a count");
        assert!(
            claim_rejected(&store, &handle, true)
                .expect("a claim")
                .is_empty(),
            "an empty inbox claims nothing and writes nothing"
        );
        assert_eq!(store.count(&handle).expect("a count"), base);

        queue_steer(&store, &handle, text("steer"), None).expect("queued");
        let queued = queue_turn(
            &store,
            &handle,
            text("prompt"),
            Some(json!({"kind": "subagent"})),
        )
        .expect("queued");
        assert_eq!(pending_inbox(&store, &handle).unwrap().next_turn, [queued]);
        let claimed = claim_rejected(&store, &handle, true).expect("a claim");
        assert_eq!(
            claimed
                .iter()
                .map(|message| crate::text_of(&message.content))
                .collect::<Vec<_>>(),
            ["steer", "prompt"],
            "the next-step list first, then the queued turn, as DSH's claim orders them"
        );
        let events = store.read(&handle).expect("readable");
        let events: Vec<&SessionEvent> = events
            .iter()
            .skip(base as usize)
            .map(|event| event.as_ref())
            .collect();
        let kinds: Vec<(&str, Option<&Value>, Option<&Value>)> = events
            .iter()
            .map(|event| {
                (
                    event.kind.as_str(),
                    event.fields.get("target"),
                    event.fields.get("removedCount"),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                (INBOX_SPLICED, Some(&json!("next-step")), None),
                (INBOX_SPLICED, Some(&json!("next-turn")), None),
                (INBOX_SPLICED, Some(&json!("next-step")), Some(&json!(1))),
                (INBOX_SPLICED, Some(&json!("next-turn")), Some(&json!(1))),
            ],
            "no message is written"
        );
        assert!(
            events
                .iter()
                .all(|event| event.fields.get("outcome").is_none())
        );
        let inbox = pending_inbox(&store, &handle).unwrap();
        assert!(inbox.next_step.is_empty() && inbox.next_turn.is_empty());
    }

    #[test]
    fn the_archived_lineage_follows_subagent_parents_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().to_str().unwrap(), &heddle_config::Env::default());
        let parent = store.create(CreateOptions::default()).expect("a session");
        let child = store
            .create(CreateOptions {
                parent_session: Some(parent.id.clone()),
                origin: Some(crate::SessionOrigin::Subagent),
                delegation_depth: Some(1),
                ..CreateOptions::default()
            })
            .expect("a child");
        let fork = store
            .create(CreateOptions {
                parent_session: Some(parent.id.clone()),
                ..CreateOptions::default()
            })
            .expect("a fork");
        assert!(!store.under_archived(&parent.id) && !store.under_archived(&child.id));
        store
            .flags(
                &parent.id,
                crate::FlagPatch {
                    pinned: None,
                    archived: Some(true),
                },
            )
            .unwrap();
        assert!(store.under_archived(&parent.id), "an archived session");
        assert!(store.under_archived(&child.id), "its subagent child");
        assert!(!store.under_archived(&fork.id), "not its fork");
        assert!(
            !store.under_archived("session-unknown"),
            "nor an unknown id"
        );
    }
}
