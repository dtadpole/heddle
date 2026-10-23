//! [`SessionLog`] over `heddle-session`'s store: what the boot passes when it builds the todo service.
//!
//! The TypeScript service reads `store.read(handle)` and appends `store.append(handle, body)`; here the store
//! is reached through the same three verbs by session id, so the service, the tools and the route stay
//! written against the port and the tests keep their in-memory double.

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
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use heddle_config::Env;
    use heddle_session::CreateOptions;
    use serde_json::json;

    use super::*;
    use crate::service::{TodoConfig, TodoService, TodoStatus};

    /// A store under a fresh directory, removed when the guard drops.
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
            "heddle-todo-store-{label}-{}-{}",
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

    #[test]
    fn a_write_lands_in_the_transcript_with_seq_and_at_in_front_of_the_typescript_keys() {
        let fixture = fixture("write");
        let todos = TodoService::new(fixture.store.clone(), TodoConfig::default());
        let view = todos
            .write(
                &fixture.session,
                &json!([{"content": "port the store", "status": "in_progress"}]),
            )
            .unwrap();
        assert_eq!(view.todos[0].status, TodoStatus::InProgress);

        let handle = fixture.store.open(&fixture.session).unwrap();
        let events = fixture.store.read(&handle).unwrap();
        let written = events
            .iter()
            .find(|event| event.kind == "todo/write")
            .expect("the write is in the log");
        let line = written.to_line();
        let keys: Vec<&str> = [
            "\"seq\"",
            "\"at\"",
            "\"type\"",
            "\"version\"",
            "\"todos\"",
            "\"updatedAt\"",
        ]
        .into_iter()
        .collect();
        let positions: Vec<usize> = keys.iter().map(|key| line.find(key).expect(key)).collect();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "the keys are in the TypeScript order: {line}"
        );
        assert_eq!(written.get("updatedAt"), Some(&json!(view.updated_at)));
    }

    #[test]
    fn the_fold_reads_back_through_a_reopened_store() {
        let fixture = fixture("reopen");
        let todos = TodoService::new(fixture.store.clone(), TodoConfig::default());
        todos
            .write(
                &fixture.session,
                &json!([{"content": "persist", "status": "pending"}]),
            )
            .unwrap();
        let reopened = Arc::new(SessionStore::new(fixture.store.root(), &Env::default()));
        let again = TodoService::new(reopened, TodoConfig::default());
        let view = again
            .get(&fixture.session)
            .unwrap()
            .expect("the durable list");
        assert_eq!(view.todos[0].content, "persist");
    }

    #[test]
    fn an_unknown_session_is_a_log_failure_and_the_route_answers_404() {
        let fixture = fixture("unknown");
        let todos = TodoService::new(fixture.store.clone(), TodoConfig::default());
        assert_eq!(
            todos.get("session-nope").unwrap_err().to_string(),
            "no session session-nope"
        );
        let answer = crate::http::get_todo(Some(&todos), Some("session-nope"));
        assert_eq!(answer.status, 404);
        let answer = crate::http::get_todo(Some(&todos), Some(&fixture.session));
        assert_eq!(answer.status, 200);
        assert!(answer.body.contains("\"todo\": null"), "{}", answer.body);
    }
}
