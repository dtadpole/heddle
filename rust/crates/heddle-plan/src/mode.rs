//! Plan mode's state: one append-only event per change, folded from the log.
//!
//! Ported from `src/plan/mode.ts`. DSH's `dsh-plan-mode` keeps `plan/mode {active}` in the session log and folds
//! it, so a mode survives a restart, a resume and a fork without a second store; this is the same event with the
//! same shape. Like `permission/mode` it is log-only — no surface position, never part of the conversation.
//!
//! What the model is told is separate: while plan mode is on, every request carries the policy section
//! ([`crate::policy`]); and when the mode changes in a session the model has already answered in, a one-line notice
//! is appended to the conversation, DSH's "The user switched this session to plan mode." — so a model that planned
//! yesterday is not surprised to find itself allowed to edit today.

use std::borrow::Borrow;
use std::sync::Arc;

use heddle_session::{
    AppendOptions, Events, NewEvent, SessionEvent, SessionHandle, SessionStore, SurfaceOp,
};
use serde_json::{Value, json};

/// The event one change appends.
pub const PLAN_EVENT: &str = "plan/mode";

/// The origin a mode-change notice is recorded with.
pub const PLAN_NOTICE_ORIGIN: &str = "plan-mode";

/// DSH's notice when a session enters plan mode, word for word.
pub const PLAN_ON_NOTICE: &str = "The user switched this session to plan mode.";

/// DSH's notice when a session leaves plan mode, word for word.
pub const PLAN_OFF_NOTICE: &str = "The user switched this session back to the default mode.";

/// The event a notice is recorded as: a `context/note` the model reads, never a `message`.
pub const NOTICE_EVENT: &str = "context/note";

/// The event whose presence says the model has answered in a session before.
pub const MODEL_REQUEST_EVENT: &str = "model/request";

/// The part of the session store a change reads and writes.
pub trait PlanLog: Send + Sync {
    /// Every event of the session, in order; an error is the store's sentence.
    fn read(&self, session: &SessionHandle) -> Result<Events, String>;
    /// Append one event and answer it as recorded; an error is the store's sentence.
    fn append(
        &self,
        session: &SessionHandle,
        event: NewEvent,
        options: AppendOptions,
    ) -> Result<Arc<SessionEvent>, String>;
}

/// The part of the session store a request's lookup needs on top of the log: a session by its id.
pub trait PlanSessions: PlanLog {
    /// The session `id` names, or `None`.
    fn open(&self, id: &str) -> Option<SessionHandle>;
}

impl PlanLog for SessionStore {
    fn read(&self, session: &SessionHandle) -> Result<Events, String> {
        SessionStore::read(self, session).map_err(|error| error.to_string())
    }

    fn append(
        &self,
        session: &SessionHandle,
        event: NewEvent,
        options: AppendOptions,
    ) -> Result<Arc<SessionEvent>, String> {
        SessionStore::append(self, session, event, options).map_err(|error| error.to_string())
    }
}

impl PlanSessions for SessionStore {
    fn open(&self, id: &str) -> Option<SessionHandle> {
        SessionStore::open(self, id)
    }
}

/// Whether a log is in plan mode: its last `plan/mode` event, or off when it has none.
///
/// `event.active === true`, as the TypeScript fold reads it: anything but the boolean `true` is off.
pub fn plan_active<E: Borrow<SessionEvent>>(events: &[E]) -> bool {
    events
        .iter()
        .rev()
        .map(Borrow::borrow)
        .find(|event| event.kind == PLAN_EVENT)
        .is_some_and(|event| event.get("active") == Some(&Value::Bool(true)))
}

/// What a change did: written, or nothing because the session was already in that mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanChange {
    /// `committed`: the mode event (and, when due, the notice) was written.
    Committed,
    /// `noop`: the session was already in that mode; nothing was written.
    Noop,
}

impl PlanChange {
    /// `committed` or `noop`, as the TypeScript build spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            PlanChange::Committed => "committed",
            PlanChange::Noop => "noop",
        }
    }
}

/// The notice a change to `active` appends, as the `message` of its `context/note`.
pub fn notice_message(active: bool) -> Value {
    let text = if active {
        PLAN_ON_NOTICE
    } else {
        PLAN_OFF_NOTICE
    };
    json!({ "role": "user", "content": [{ "type": "text", "text": text }] })
}

/// Switch a session into or out of plan mode.
///
/// The mode event is written first, then — when the model has answered in this session before — the notice, so the
/// next request both carries (or drops) the policy section and reads why. A change to the mode already in effect
/// writes nothing. An `Err` is the store refusing a read or an append.
pub fn set_plan_mode(
    log: &dyn PlanLog,
    session: &SessionHandle,
    active: bool,
) -> Result<PlanChange, String> {
    let events = log.read(session)?;
    if plan_active(events.as_slice()) == active {
        return Ok(PlanChange::Noop);
    }
    log.append(
        session,
        NewEvent::new(PLAN_EVENT).field("active", active),
        AppendOptions::default(),
    )?;
    if events.iter().any(|event| event.kind == MODEL_REQUEST_EVENT) {
        log.append(
            session,
            NewEvent::new(NOTICE_EVENT)
                .field("message", notice_message(active))
                .field("origin", PLAN_NOTICE_ORIGIN),
            AppendOptions {
                surface_op: Some(SurfaceOp::Append),
                ..AppendOptions::default()
            },
        )?;
    }
    Ok(PlanChange::Committed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    use heddle_session::fold_surface;

    #[test]
    fn the_mode_is_the_last_plan_mode_event_off_when_there_is_none_and_a_change_to_the_current_mode_writes_nothing()
     {
        let fixture = Fixture::new("fold");
        let (log, handle) = (fixture.log(), &fixture.handle);
        assert!(!plan_active(fixture.events().as_slice()));
        assert_eq!(set_plan_mode(log, handle, false), Ok(PlanChange::Noop));
        assert_eq!(set_plan_mode(log, handle, true), Ok(PlanChange::Committed));
        assert!(plan_active(fixture.events().as_slice()));
        let before = fixture.events().len();
        assert_eq!(set_plan_mode(log, handle, true), Ok(PlanChange::Noop));
        assert_eq!(fixture.events().len(), before);
        assert_eq!(set_plan_mode(log, handle, false), Ok(PlanChange::Committed));
        assert!(!plan_active(fixture.events().as_slice()));
        let modes: Vec<Value> = fixture
            .events()
            .iter()
            .filter(|event| event.kind == PLAN_EVENT)
            .filter_map(|event| event.get("active").cloned())
            .collect();
        assert_eq!(modes, [json!(true), json!(false)]);
        assert_eq!(PlanChange::Committed.as_str(), "committed");
        assert_eq!(PlanChange::Noop.as_str(), "noop");
    }

    #[test]
    fn only_the_boolean_true_is_on() {
        let fixture = Fixture::new("fold-truthy");
        for active in [json!("true"), json!(1), Value::Null] {
            fixture
                .store
                .append(
                    &fixture.handle,
                    NewEvent::new(PLAN_EVENT).field("active", active.clone()),
                    AppendOptions::default(),
                )
                .unwrap();
            assert!(!plan_active(fixture.events().as_slice()), "{active}");
        }
    }

    #[test]
    fn the_mode_event_is_log_only_and_a_notice_is_added_only_once_the_model_has_answered_in_the_session()
     {
        let fixture = Fixture::new("notice");
        let (log, handle) = (fixture.log(), &fixture.handle);
        let surface = || {
            fold_surface(fixture.events().as_slice())
                .unwrap()
                .nodes
                .len()
        };
        let start = surface();
        set_plan_mode(log, handle, true).unwrap();
        assert_eq!(
            surface(),
            start,
            "a fresh session gets no notice: the policy section alone tells the model"
        );
        assert!(
            !fixture
                .events()
                .iter()
                .any(|event| event.kind == NOTICE_EVENT)
        );
        let mode = fixture.events().last().cloned().unwrap();
        assert_eq!(mode.kind, PLAN_EVENT);
        assert_eq!(mode.get("surfaceOp"), None, "the mode event is log-only");

        fixture
            .store
            .append(
                handle,
                NewEvent::new(MODEL_REQUEST_EVENT).field("messages", 1),
                AppendOptions::default(),
            )
            .unwrap();
        set_plan_mode(log, handle, false).unwrap();
        let events = fixture.events();
        let notes: Vec<&Arc<SessionEvent>> = events
            .iter()
            .filter(|event| event.kind == NOTICE_EVENT)
            .collect();
        assert_eq!(notes.len(), 1);
        assert_eq!(
            notes[0].get("message"),
            Some(
                &json!({ "role": "user", "content": [{ "type": "text", "text": PLAN_OFF_NOTICE }] })
            )
        );
        assert_eq!(notes[0].get("origin"), Some(&json!("plan-mode")));
        assert_eq!(notes[0].get("surfaceOp"), Some(&json!("append")));
        assert_eq!(
            surface(),
            start + 1,
            "the notice is part of the conversation the model reads"
        );
        // The mode event is written before the notice, and the bytes keep the TypeScript build's key order.
        let mode_seq = events
            .iter()
            .rev()
            .find(|event| event.kind == PLAN_EVENT)
            .unwrap()
            .seq;
        assert!(mode_seq < notes[0].seq);
        let line = notes[0].to_line();
        let body = line.split_once(r#""type":"context/note","#).unwrap().1;
        assert_eq!(
            body,
            format!(
                r#""message":{{"role":"user","content":[{{"type":"text","text":"{PLAN_OFF_NOTICE}"}}]}},"origin":"plan-mode","surfaceOp":"append"}}"#
            )
        );

        set_plan_mode(log, handle, true).unwrap();
        let events = fixture.events();
        let last = events
            .iter()
            .rev()
            .find(|event| event.kind == NOTICE_EVENT)
            .unwrap();
        assert!(
            last.get("message")
                .unwrap()
                .to_string()
                .contains(PLAN_ON_NOTICE)
        );
    }
}
