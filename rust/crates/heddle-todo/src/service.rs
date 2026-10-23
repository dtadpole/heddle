//! The event-sourced list: the `todo/write` shape, validation, the fold, and the service.

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
    let _ = (raw, code, allow_parallel);
    todo!("heddle-todo: validate_todos")
}

/// Count one list; the only place the three numbers are derived.
pub fn counts_of(todos: &[TodoItem]) -> TodoCounts {
    let _ = todos;
    todo!("heddle-todo: counts_of")
}

/// Decode one session event: `Ok(None)` when it is not a `todo/write`; an error (`TODO_INVALID_LOG`) when it
/// is one with another version, an invalid list, or no `updatedAt`. Malformed events fail loudly rather than
/// being skipped.
pub fn decode_todo_write(event: &Value) -> Result<Option<TodoWrite>, TodoError> {
    let _ = event;
    todo!("heddle-todo: decode_todo_write")
}

/// Fold a session's events into its current list: the last write wins; `None` before the first write.
pub fn fold_todos(events: &[Value]) -> Result<Option<TodoView>, TodoError> {
    let _ = events;
    todo!("heddle-todo: fold_todos")
}

/// The body a write appends, in the TypeScript key order: `{type, version, todos, updatedAt}`.
pub fn todo_write_event(todos: &[TodoItem], updated_at: &str) -> Map<String, Value> {
    let _ = (todos, updated_at);
    todo!("heddle-todo: todo_write_event")
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
        let _ = session;
        todo!("heddle-todo: TodoService::get")
    }

    /// Replace the whole list with `raw` (validated with `TODO_INVALID_LIST` and the service's parallel
    /// policy); returns the view the write produced.
    pub fn write(&self, session: &str, raw: &Value) -> Result<TodoView, TodoError> {
        let _ = (session, raw, self.allow_parallel, &self.clock);
        todo!("heddle-todo: TodoService::write")
    }

    /// Replace the list with the empty one: the dock hides it, and the log keeps the event.
    pub fn clear(&self, session: &str) -> Result<TodoView, TodoError> {
        let _ = session;
        todo!("heddle-todo: TodoService::clear")
    }
}
