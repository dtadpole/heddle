//! [`SessionLog`] over `heddle-session`'s store: what the boot passes when it builds the goal service.
//!
//! The same three verbs as `heddle-todo`'s, kept separate so either plugin loads without the other. The
//! round's user message is the store's own `message` event with its `source` inline, which is what the fold
//! counts as an admitted round.

use heddle_session::{AppendOptions, NewEvent, SessionStore};
use serde_json::{Map, Value};

use crate::log::{LogError, SessionLog};

impl SessionLog for SessionStore {
    fn open(&self, id: &str) -> Option<String> {
        SessionStore::open(self, id).map(|handle| handle.id)
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, LogError> {
        let handle = SessionStore::open(self, session)
            .ok_or_else(|| LogError(format!("no session {session}")))?;
        let events =
            SessionStore::read(self, &handle).map_err(|error| LogError(error.to_string()))?;
        Ok(events.iter().map(|event| event.to_value()).collect())
    }

    fn append(&self, session: &str, event: Map<String, Value>) -> Result<Value, LogError> {
        let handle = SessionStore::open(self, session)
            .ok_or_else(|| LogError(format!("no session {session}")))?;
        let body = NewEvent::try_from(Value::Object(event))
            .map_err(|error| LogError(error.to_string()))?;
        let written = SessionStore::append(self, &handle, body, AppendOptions::default())
            .map_err(|error| LogError(error.to_string()))?;
        Ok(written.to_value())
    }

    fn meta(&self, session: &str) -> Option<Value> {
        SessionStore::meta(self, session).map(|meta| meta.to_value())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use heddle_config::Env;
    use heddle_session::{ContentPart, CreateOptions, RecordedMessage, Role};
    use serde_json::json;

    use super::*;
    use crate::service::{CreateGoal, GoalActivation, GoalConfig, GoalPhase, GoalRef, GoalService};

    struct Fixture {
        root: PathBuf,
        store: Arc<SessionStore>,
        session: String,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture(label: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "heddle-goal-store-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let store = Arc::new(SessionStore::new(
            &root.join("sessions").display().to_string(),
            &Env::default(),
        ));
        let handle = store
            .create(CreateOptions {
                cwd: Some(work.display().to_string()),
                ..CreateOptions::default()
            })
            .unwrap();
        Fixture {
            root,
            store,
            session: handle.id,
        }
    }

    fn round_message(store: &SessionStore, session: &str, goal: &str, revision: u64, round: u64) {
        let handle = store.open(session).unwrap();
        store
            .message(
                &handle,
                RecordedMessage {
                    role: Role::User,
                    tool_call_id: None,
                    content: vec![ContentPart::Text {
                        text: format!("Round: {round}"),
                    }],
                    source: Some(json!({"kind": "goal", "goalId": goal, "revision": revision, "round": round})),
                },
            )
            .unwrap();
    }

    #[test]
    fn a_goal_lives_in_the_real_log_and_counts_the_rounds_the_store_recorded() {
        let fixture = fixture("rounds");
        let goals = GoalService::new(fixture.store.clone(), GoalConfig::default());
        let created = goals
            .create(
                &fixture.session,
                CreateGoal {
                    objective: "walk two rounds".into(),
                    max_goal_rounds: Some(2.0),
                },
            )
            .unwrap();
        assert!(created.goal.id.starts_with("goal-"));
        round_message(&fixture.store, &fixture.session, &created.goal.id, 1, 1);
        round_message(&fixture.store, &fixture.session, &created.goal.id, 1, 2);
        let view = goals.get(&fixture.session).unwrap().unwrap();
        assert_eq!(
            view.rounds_started, 2,
            "the fold counts the store's attributed messages"
        );

        let handle = fixture.store.open(&fixture.session).unwrap();
        let line = fixture
            .store
            .read(&handle)
            .unwrap()
            .iter()
            .find(|event| event.kind == "goal/change")
            .unwrap()
            .to_line();
        let order = [
            "\"seq\"",
            "\"at\"",
            "\"type\"",
            "\"version\"",
            "\"operation\"",
            "\"goal\"",
            "\"roundsStarted\"",
            "\"createdAt\"",
            "\"updatedAt\"",
        ];
        let positions: Vec<usize> = order.iter().map(|key| line.find(key).expect(key)).collect();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "TypeScript key order: {line}"
        );
    }

    #[test]
    fn a_reopened_store_folds_the_same_goal_and_an_active_one_is_armed_again() {
        let fixture = fixture("reopen");
        let goals = GoalService::new(fixture.store.clone(), GoalConfig::default());
        let created = goals
            .create(
                &fixture.session,
                CreateGoal {
                    objective: "survive a restart".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        goals.disarm(&fixture.session).unwrap();
        let reopened = Arc::new(SessionStore::new(fixture.store.root(), &Env::default()));
        let again = GoalService::new(reopened, GoalConfig::default());
        let view = again.get(&fixture.session).unwrap().unwrap();
        assert_eq!(view.goal.id, created.goal.id);
        assert_eq!(view.goal.phase, GoalPhase::Active);
        assert_eq!(
            view.activation,
            GoalActivation::Armed,
            "pushing survives a restart"
        );
        let cleared = again
            .clear(
                &fixture.session,
                &GoalRef {
                    id: created.goal.id.clone(),
                    revision: 1,
                },
            )
            .unwrap();
        assert_eq!(cleared.revision, 2);
        assert_eq!(again.get(&fixture.session).unwrap(), None);
    }

    /// A person's message as the real store writes it: no `source` key at all.
    fn person_message(store: &SessionStore, session: &str) {
        let handle = store.open(session).unwrap();
        store
            .message(
                &handle,
                RecordedMessage {
                    role: Role::User,
                    tool_call_id: None,
                    content: vec![ContentPart::Text {
                        text: "finish it, however long it takes".into(),
                    }],
                    source: None,
                },
            )
            .unwrap();
    }

    #[test]
    fn the_goal_tools_read_authority_from_the_real_store_and_its_delegation_depth() {
        let fixture = fixture("authority");
        let goals = GoalService::new(fixture.store.clone(), GoalConfig::default());
        let create = json!({"objective": "one"});

        // A top-level session: a person's message opens a direct human turn.
        assert_eq!(
            goals
                .session_meta(&fixture.session)
                .unwrap()
                .get("delegationDepth"),
            None
        );
        let refused = crate::tool::run_create_goal(&goals, Some(&fixture.session), &create);
        assert_eq!(
            refused.error.unwrap().code,
            "GOAL_TOOL_AUTHORITY_REQUIRED",
            "no message, no authority"
        );
        person_message(&fixture.store, &fixture.session);
        let created = crate::tool::run_create_goal(&goals, Some(&fixture.session), &create);
        assert_eq!(created.error, None, "{created:?}");

        // A delegated session: the record's delegationDepth takes a person's authority away.
        let delegated = fixture
            .store
            .create(CreateOptions {
                cwd: Some(fixture.root.join("work").display().to_string()),
                parent_session: Some(fixture.session.clone()),
                origin: Some(heddle_session::SessionOrigin::Subagent),
                delegation_depth: Some(1),
                ..CreateOptions::default()
            })
            .unwrap()
            .id;
        assert_eq!(
            goals.session_meta(&delegated).unwrap()["delegationDepth"],
            1
        );
        person_message(&fixture.store, &delegated);
        let answer = crate::tool::run_create_goal(&goals, Some(&delegated), &create);
        assert_eq!(
            answer.error.unwrap().message,
            "this goal operation requires a direct human turn on a top-level agent"
        );
    }

    #[test]
    fn the_routes_answer_from_the_real_store() {
        let fixture = fixture("routes");
        let goals = GoalService::new(fixture.store.clone(), GoalConfig::default());
        let created = crate::http::post_goal(
            Some(&goals),
            &json!({"session": fixture.session, "action": "create", "objective": "one", "max_goal_rounds": 500}),
        );
        assert_eq!(created.status, 200, "{}", created.body);
        let unknown = crate::http::get_goal(Some(&goals), Some("session-nope"));
        assert_eq!(unknown.status, 404);
        let current = crate::http::get_goal(Some(&goals), Some(&fixture.session));
        assert_eq!(current.status, 200);
        assert!(
            current.body.contains("\"maxGoalRounds\": 500"),
            "{}",
            current.body
        );
    }
}
