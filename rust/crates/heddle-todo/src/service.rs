//! The event-sourced list: the `todo/write` shape, validation, the fold, and the service.

use std::collections::HashSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::log::{Clock, LogError, SessionLog, SystemClock};

/// Version of the `todo/write` payload shape. A log written by a later version fails loudly.
pub const TODO_WRITE_VERSION: u64 = 1;

/// The event type a write appends.
pub const TODO_WRITE_EVENT: &str = "todo/write";

/// The statuses a todo item may carry — DSH's closed set, serialized `pending`, `in_progress`, `completed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    /// Not started.
    Pending,
    /// Being worked on now.
    InProgress,
    /// Done.
    Completed,
}

impl TodoStatus {
    /// Every status, in the order the tool's schema lists them.
    pub const ALL: [TodoStatus; 3] = [
        TodoStatus::Pending,
        TodoStatus::InProgress,
        TodoStatus::Completed,
    ];

    /// The serialized name.
    pub const fn as_str(self) -> &'static str {
        match self {
            TodoStatus::Pending => "pending",
            TodoStatus::InProgress => "in_progress",
            TodoStatus::Completed => "completed",
        }
    }

    /// The status a name denotes, if it is one of the three.
    pub fn parse(name: &str) -> Option<TodoStatus> {
        TodoStatus::ALL
            .into_iter()
            .find(|status| status.as_str() == name)
    }
}

/// One item as it is stored and shown: a short line and its status. Serialized `{content, status}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    /// The trimmed, non-empty line, unique within its list.
    pub content: String,
    /// Its status.
    pub status: TodoStatus,
}

/// The three counts the dock and the tool answer report. Serialized `{pending, inProgress, completed}`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCounts {
    /// Items pending.
    pub pending: u64,
    /// Items in progress.
    pub in_progress: u64,
    /// Items completed.
    pub completed: u64,
}

/// A session's current list with what a caller needs to render it. Serialized `{todos, counts, updatedAt}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoView {
    /// The list, in the order written.
    pub todos: Vec<TodoItem>,
    /// Its counts.
    pub counts: TodoCounts,
    /// When the write that produced it happened.
    pub updated_at: String,
}

/// One decoded `todo/write` event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodoWrite {
    /// The whole list it wrote.
    pub todos: Vec<TodoItem>,
    /// Its `updatedAt`.
    pub updated_at: String,
}

/// Which refusal a validation failure is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TodoErrorCode {
    /// `TODO_INVALID_LIST`: a model's write was refused.
    InvalidList,
    /// `TODO_INVALID_LOG`: the log holds a `todo/write` that does not decode.
    InvalidLog,
}

impl TodoErrorCode {
    /// The stable code a tool answer or a Web client branches on.
    pub const fn as_str(self) -> &'static str {
        match self {
            TodoErrorCode::InvalidList => "TODO_INVALID_LIST",
            TodoErrorCode::InvalidLog => "TODO_INVALID_LOG",
        }
    }
}

/// A refused or failed todo operation.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TodoError {
    /// A list or a logged write did not validate; the message is the TypeScript build's sentence.
    #[error("{message}")]
    Invalid {
        /// Which refusal.
        code: TodoErrorCode,
        /// The sentence, e.g. `at most one todo may be in_progress (got 2)`.
        message: String,
    },
    /// The session log failed. A tool reports it under `TODO_TOOL_ERROR`, as the TypeScript build reports any
    /// error that is not a `TodoError`.
    #[error("{0}")]
    Log(#[from] LogError),
}

impl TodoError {
    /// The stable code, for a validation refusal.
    pub fn code(&self) -> Option<TodoErrorCode> {
        match self {
            TodoError::Invalid { code, .. } => Some(*code),
            TodoError::Log(_) => None,
        }
    }
}

/// Validate one raw list the way both the write path and the fold need it.
///
/// Refused (with `code`): not an array; an item that is not an object, has a key other than `content` and
/// `status`, has non-string or blank content, repeats a trimmed content, or has an unknown status; and, unless
/// `allow_parallel`, more than one `in_progress`. Content is stored trimmed. `allow_parallel` is a **policy**:
/// the write path applies the service's, the fold passes `true`, so changing a deployment's policy never makes
/// an older log unreadable.
pub fn validate_todos(
    raw: &Value,
    code: TodoErrorCode,
    allow_parallel: bool,
) -> Result<Vec<TodoItem>, TodoError> {
    let Some(items) = raw.as_array() else {
        return Err(refusal(code, "todos must be an array"));
    };
    let mut todos = Vec::with_capacity(items.len());
    let mut seen: HashSet<String> = HashSet::new();
    let mut active = 0usize;
    for raw_item in items {
        let Some(item) = raw_item.as_object() else {
            return Err(refusal(code, "a todo must be an object"));
        };
        for key in item.keys() {
            if key != "content" && key != "status" {
                return Err(refusal(
                    code,
                    format!(
                        "unknown todo key {}",
                        json_text(&Value::String(key.clone()))
                    ),
                ));
            }
        }
        let Some(content) = item.get("content").and_then(Value::as_str) else {
            return Err(refusal(code, "todo content must be a string"));
        };
        let content = content.trim();
        if content.is_empty() {
            return Err(refusal(code, "todo content must be non-empty"));
        }
        if !seen.insert(content.to_owned()) {
            return Err(refusal(
                code,
                format!(
                    "duplicate todo content {}",
                    json_text(&Value::String(content.to_owned()))
                ),
            ));
        }
        let status = match item.get("status") {
            Some(Value::String(name)) => TodoStatus::parse(name),
            _ => None,
        };
        let Some(status) = status else {
            let shown = item
                .get("status")
                .map(json_text)
                .unwrap_or_else(|| "undefined".to_owned());
            return Err(refusal(code, format!("unknown todo status {shown}")));
        };
        if status == TodoStatus::InProgress {
            active += 1;
        }
        todos.push(TodoItem {
            content: content.to_owned(),
            status,
        });
    }
    if !allow_parallel && active > 1 {
        return Err(refusal(
            code,
            format!("at most one todo may be in_progress (got {active})"),
        ));
    }
    Ok(todos)
}

/// One refusal, with the code the caller named.
fn refusal(code: TodoErrorCode, message: impl Into<String>) -> TodoError {
    TodoError::Invalid {
        code,
        message: message.into(),
    }
}

/// A JSON value the way `JSON.stringify` writes it into a message.
fn json_text(value: &Value) -> String {
    match value {
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| text.clone()),
        other => serde_json::to_string(other).unwrap_or_else(|_| "undefined".to_owned()),
    }
}

/// The text `String(value)` produces for a version number, in the TypeScript message.
fn version_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Null => "null".to_owned(),
        other => json_text(other),
    }
}

/// Count one list; the only place the three numbers are derived.
pub fn counts_of(todos: &[TodoItem]) -> TodoCounts {
    let mut counts = TodoCounts::default();
    for todo in todos {
        match todo.status {
            TodoStatus::Pending => counts.pending += 1,
            TodoStatus::InProgress => counts.in_progress += 1,
            TodoStatus::Completed => counts.completed += 1,
        }
    }
    counts
}

/// Decode one session event: `Ok(None)` when it is not a `todo/write`; an error (`TODO_INVALID_LOG`) when it
/// is one with another version, an invalid list, or no `updatedAt`. Malformed events fail loudly rather than
/// being skipped.
pub fn decode_todo_write(event: &Value) -> Result<Option<TodoWrite>, TodoError> {
    let Some(object) = event.as_object() else {
        return Ok(None);
    };
    if object.get("type").and_then(Value::as_str) != Some(TODO_WRITE_EVENT) {
        return Ok(None);
    }
    if object.get("version") != Some(&Value::from(TODO_WRITE_VERSION)) {
        let shown = object
            .get("version")
            .map(version_text)
            .unwrap_or_else(|| "undefined".to_owned());
        return Err(refusal(
            TodoErrorCode::InvalidLog,
            format!("unsupported todo write version {shown}"),
        ));
    }
    let todos = validate_todos(
        object.get("todos").unwrap_or(&Value::Null),
        TodoErrorCode::InvalidLog,
        true,
    )?;
    match object.get("updatedAt") {
        Some(Value::String(updated_at)) if !updated_at.is_empty() => Ok(Some(TodoWrite {
            todos,
            updated_at: updated_at.clone(),
        })),
        _ => Err(refusal(
            TodoErrorCode::InvalidLog,
            "a todo write needs updatedAt",
        )),
    }
}

/// Fold a session's events into its current list: the last write wins; `None` before the first write.
pub fn fold_todos(events: &[Value]) -> Result<Option<TodoView>, TodoError> {
    let mut view = None;
    for event in events {
        if let Some(write) = decode_todo_write(event)? {
            view = Some(TodoView {
                counts: counts_of(&write.todos),
                todos: write.todos,
                updated_at: write.updated_at,
            });
        }
    }
    Ok(view)
}

/// The body a write appends, in the TypeScript key order: `{type, version, todos, updatedAt}`.
pub fn todo_write_event(todos: &[TodoItem], updated_at: &str) -> Map<String, Value> {
    let mut event = Map::new();
    event.insert(
        "type".to_owned(),
        Value::String(TODO_WRITE_EVENT.to_owned()),
    );
    event.insert("version".to_owned(), Value::from(TODO_WRITE_VERSION));
    event.insert(
        "todos".to_owned(),
        serde_json::to_value(todos).expect("a todo item is plain data"),
    );
    event.insert("updatedAt".to_owned(), Value::String(updated_at.to_owned()));
    event
}

/// The todo plugin's configuration row. Camel-case keys, as the TypeScript options.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoConfig {
    /// Accept more than one `in_progress` item in a write. Off by default, as in DSH.
    pub allow_parallel_in_progress: bool,
}

/// The todo service: read a session's list, replace it, or clear it.
///
/// `Send + Sync`; shared as an `Arc` by the tools and the route.
pub struct TodoService {
    log: Arc<dyn SessionLog>,
    clock: Arc<dyn Clock>,
    allow_parallel: bool,
}

impl TodoService {
    /// The service over `log`, stamping writes with the system clock.
    pub fn new(log: Arc<dyn SessionLog>, config: TodoConfig) -> Self {
        Self {
            log,
            clock: Arc::new(SystemClock),
            allow_parallel: config.allow_parallel_in_progress,
        }
    }

    /// The same service with another clock — for tests.
    pub fn with_clock(self, clock: Arc<dyn Clock>) -> Self {
        Self { clock, ..self }
    }

    /// The session log the service reads, for the route's session lookup.
    pub fn log(&self) -> &dyn SessionLog {
        self.log.as_ref()
    }

    /// The session's current list, or `None` when nothing has been written yet.
    pub fn get(&self, session: &str) -> Result<Option<TodoView>, TodoError> {
        let session = self.session_of(session)?;
        let events = self.log.read(&session)?;
        fold_todos(&events)
    }

    /// Replace the whole list with `raw` (validated with `TODO_INVALID_LIST` and the service's parallel
    /// policy); returns the view the write produced.
    pub fn write(&self, session: &str, raw: &Value) -> Result<TodoView, TodoError> {
        // The list is validated before the log is touched, as the TypeScript build does.
        let todos = validate_todos(raw, TodoErrorCode::InvalidList, self.allow_parallel)?;
        let session = self.session_of(session)?;
        self.commit(&session, todos)
    }

    /// Replace the list with the empty one: the dock hides it, and the log keeps the event.
    pub fn clear(&self, session: &str) -> Result<TodoView, TodoError> {
        let session = self.session_of(session)?;
        self.commit(&session, Vec::new())
    }

    /// Resolve the session the caller named, so every method works on the canonical id.
    fn session_of(&self, session: &str) -> Result<String, TodoError> {
        self.log
            .open(session)
            .ok_or_else(|| TodoError::Log(LogError(format!("no session {session}"))))
    }

    /// Append one whole-list write and answer the view it produced.
    fn commit(&self, session: &str, todos: Vec<TodoItem>) -> Result<TodoView, TodoError> {
        let updated_at = self.clock.now();
        self.log
            .append(session, todo_write_event(&todos, &updated_at))?;
        let counts = counts_of(&todos);
        Ok(TodoView {
            todos,
            counts,
            updated_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::{FIXED_NOW, fixture};

    fn invalid_code(error: TodoError) -> &'static str {
        error.code().expect("a validation refusal").as_str()
    }

    #[test]
    fn a_session_with_no_write_has_no_list() {
        let (_log, service) = fixture("s1");
        assert_eq!(service.get("s1").unwrap(), None);
    }

    #[test]
    fn a_write_replaces_the_whole_list_and_the_last_write_wins() {
        let (_log, service) = fixture("s1");
        let first = service
            .write(
                "s1",
                &json!([
                    {"content": "research DSH", "status": "in_progress"},
                    {"content": "write the service", "status": "pending"}
                ]),
            )
            .unwrap();
        assert_eq!(first.todos.len(), 2);
        assert_eq!(
            first.counts,
            TodoCounts {
                pending: 1,
                in_progress: 1,
                completed: 0
            }
        );
        assert_eq!(first.updated_at, FIXED_NOW);
        let second = service
            .write(
                "s1",
                &json!([{"content": "research DSH", "status": "completed"}]),
            )
            .unwrap();
        assert_eq!(second.todos.len(), 1);
        assert_eq!(second.todos[0].status, TodoStatus::Completed);
        assert_eq!(service.get("s1").unwrap().unwrap().todos, second.todos);
    }

    #[test]
    fn an_empty_list_is_a_list_not_an_absent_one() {
        let (_log, service) = fixture("s1");
        service
            .write("s1", &json!([{"content": "one", "status": "pending"}]))
            .unwrap();
        let cleared = service.clear("s1").unwrap();
        assert!(cleared.todos.is_empty());
        assert_eq!(cleared.counts, TodoCounts::default());
        let read = service.get("s1").unwrap().expect("cleared is written");
        assert!(read.todos.is_empty());
    }

    #[test]
    fn content_is_trimmed_and_stored_trimmed() {
        let (_log, service) = fixture("s1");
        let view = service
            .write(
                "s1",
                &json!([{"content": "  a task  ", "status": "pending"}]),
            )
            .unwrap();
        assert_eq!(view.todos[0].content, "a task");
    }

    #[test]
    fn the_write_path_refuses_invalid_lists_with_a_stable_code() {
        let (_log, service) = fixture("s1");
        let refusals = [
            json!("nope"),
            json!([{"content": "   ", "status": "pending"}]),
            json!([{"content": "a", "status": "pending"}, {"content": " a ", "status": "completed"}]),
            json!([{"content": "a", "status": "doing"}]),
            json!([{"content": "a", "status": "pending", "note": "x"}]),
            json!([{"content": "a", "status": "in_progress"}, {"content": "b", "status": "in_progress"}]),
            json!(["not an object"]),
            json!([{"content": 7, "status": "pending"}]),
        ];
        for raw in refusals {
            let error = service.write("s1", &raw).unwrap_err();
            assert_eq!(invalid_code(error), "TODO_INVALID_LIST", "{raw}");
        }
    }

    #[test]
    fn the_refusals_say_the_typescript_sentence() {
        let (_log, service) = fixture("s1");
        for (raw, message) in [
            (json!("nope"), "todos must be an array"),
            (
                json!([{"content": "a", "status": "pending"}, {"content": " a", "status": "completed"}]),
                "duplicate todo content \"a\"",
            ),
            (
                json!([{"content": "a", "status": "doing"}]),
                "unknown todo status \"doing\"",
            ),
            (
                json!([{"content": "a", "status": "pending", "note": "x"}]),
                "unknown todo key \"note\"",
            ),
            (
                json!([{"content": "a", "status": "in_progress"}, {"content": "b", "status": "in_progress"}]),
                "at most one todo may be in_progress (got 2)",
            ),
            (json!([{"content": "a"}]), "unknown todo status undefined"),
        ] {
            let error = service.write("s1", &raw).unwrap_err();
            assert_eq!(error.to_string(), message, "{raw}");
        }
    }

    #[test]
    fn a_bad_list_is_refused_before_the_session_is_opened() {
        let (_log, service) = fixture("s1");
        let error = service.write("nobody", &json!("nope")).unwrap_err();
        assert_eq!(invalid_code(error), "TODO_INVALID_LIST");
    }

    #[test]
    fn the_fold_refuses_a_malformed_log_rather_than_guessing() {
        let (log, service) = fixture("s1");
        log.append_raw(
            "s1",
            json!({"type": "todo/write", "version": 99, "todos": [], "updatedAt": "now"}),
        );
        let error = service.get("s1").unwrap_err();
        assert_eq!(invalid_code(error), "TODO_INVALID_LOG");
        assert_eq!(
            service.get("s1").unwrap_err().to_string(),
            "unsupported todo write version 99"
        );

        let (second_log, second) = fixture("s2");
        second_log.append_raw(
            "s2",
            json!({"type": "todo/write", "version": 1, "todos": [{"content": "a", "status": "done"}], "updatedAt": "now"}),
        );
        let error = second.get("s2").unwrap_err();
        assert_eq!(invalid_code(error), "TODO_INVALID_LOG");
        assert_eq!(
            second.get("s2").unwrap_err().to_string(),
            "unknown todo status \"done\""
        );
    }

    #[test]
    fn the_fold_accepts_parallel_in_progress_whatever_the_service_policy_is() {
        let (log, service) = fixture("s1");
        log.append_raw(
            "s1",
            json!({"type": "todo/write", "version": 1, "todos": [
                {"content": "a", "status": "in_progress"},
                {"content": "b", "status": "in_progress"}
            ], "updatedAt": "2026-10-22T00:00:00.000Z"}),
        );
        let view = service.get("s1").unwrap().expect("the written list");
        assert_eq!(view.counts.in_progress, 2);
    }

    #[test]
    fn a_list_survives_turns_and_a_reopened_service() {
        let (log, service) = fixture("s1");
        service
            .write("s1", &json!([{"content": "persist", "status": "pending"}]))
            .unwrap();
        log.append_raw("s1", json!({"type": "turn/completed"}));
        log.append_raw(
            "s1",
            json!({"type": "message", "message": {"role": "user", "content": []}}),
        );
        assert_eq!(
            service.get("s1").unwrap().unwrap().todos[0].content,
            "persist"
        );
        let reopened = TodoService::new(log.clone(), TodoConfig::default());
        assert_eq!(
            reopened.get("s1").unwrap().unwrap().todos[0].content,
            "persist"
        );
    }

    #[test]
    fn counts_are_derived_from_the_list_never_stored() {
        assert_eq!(counts_of(&[]), TodoCounts::default());
        let todos = vec![
            TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending,
            },
            TodoItem {
                content: "b".into(),
                status: TodoStatus::InProgress,
            },
            TodoItem {
                content: "c".into(),
                status: TodoStatus::Completed,
            },
            TodoItem {
                content: "d".into(),
                status: TodoStatus::Completed,
            },
        ];
        assert_eq!(
            counts_of(&todos),
            TodoCounts {
                pending: 1,
                in_progress: 1,
                completed: 2
            }
        );
        assert_eq!(
            validate_todos(
                &json!([{"content": " a ", "status": "pending"}]),
                TodoErrorCode::InvalidList,
                false
            )
            .unwrap(),
            vec![TodoItem {
                content: "a".into(),
                status: TodoStatus::Pending
            }]
        );
        assert_eq!(fold_todos(&[]).unwrap(), None);
    }

    #[test]
    fn the_parallel_policy_on_the_write_path_can_be_lifted() {
        let log = std::sync::Arc::new(crate::test_support::MemoryLog::new());
        log.create("s1");
        let service = TodoService::new(
            log,
            TodoConfig {
                allow_parallel_in_progress: true,
            },
        );
        let view = service
            .write(
                "s1",
                &json!([{"content": "a", "status": "in_progress"}, {"content": "b", "status": "in_progress"}]),
            )
            .unwrap();
        assert_eq!(view.counts.in_progress, 2);
    }

    #[test]
    fn a_write_event_has_the_typescript_keys_and_a_whole_list() {
        let todos = vec![TodoItem {
            content: "a".into(),
            status: TodoStatus::Pending,
        }];
        let event = todo_write_event(&todos, "2026-10-22T00:00:00.000Z");
        assert_eq!(event["type"], "todo/write");
        assert_eq!(event["version"], 1);
        assert_eq!(
            event["todos"],
            json!([{"content": "a", "status": "pending"}])
        );
        assert_eq!(event["updatedAt"], "2026-10-22T00:00:00.000Z");
    }

    #[test]
    fn a_decoder_ignores_events_that_are_not_a_todo_write() {
        assert_eq!(
            decode_todo_write(&json!({"type": "message"})).unwrap(),
            None
        );
        assert_eq!(decode_todo_write(&json!("not an event")).unwrap(), None);
        let error = decode_todo_write(&json!({"type": "todo/write", "version": 1, "todos": []}))
            .unwrap_err();
        assert_eq!(error.to_string(), "a todo write needs updatedAt");
    }

    #[test]
    fn an_unknown_session_is_a_log_failure() {
        let (_log, service) = fixture("s1");
        let error = service.get("nobody").unwrap_err();
        assert_eq!(error.code(), None);
        assert_eq!(error.to_string(), "no session nobody");
    }
}
