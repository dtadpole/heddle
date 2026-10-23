//! `heddle-todo` — a session's task list: durable `todo/write` snapshots, the fold, the model's two tools,
//! and the route the Web UI's dock reads.
//!
//! Ported from the TypeScript build: `src/todo/service.ts`, `src/todo/tool.ts`, `src/plugins/todo-tool.ts`,
//! and the `GET /api/todo` branch of `src/server/web.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`)
//! by `_verifiers_/80-web-ui` (`check-todo`); the unit tests port `test/todo.test.ts`.
//!
//! # The one idea
//!
//! A todo list is not a record that is updated but an event that is appended: every write appends one
//! `todo/write` event carrying the **whole list**, and the current list is the fold of the log, last write
//! wins. The list persists across turns until it is replaced or written empty (one recorded divergence from
//! DSH, which resets it per turn), which is why `todo_read` exists.
//!
//! # Seams
//!
//! - [`SessionLog`] is the port this crate needs from `heddle-session`'s store (open, read, append); the boot
//!   passes the store, and an implementation for it lands here once its API does.
//! - [`tool`] holds the two tools as data and functions; they are registered through `heddle-tools`' registry
//!   once its API lands (until then [`tool::ToolSpec`] and [`tool::ToolAnswer`] mirror its shapes).
//! - [`http`] answers `GET /api/todo` as status and exact bytes, so `heddle-server` mounts it in one line.

#![warn(missing_docs)]

pub mod http;
mod log;
mod service;
#[cfg(test)]
mod test_support;
pub mod tool;

pub use log::{Clock, LogError, SessionLog, SystemClock, iso_timestamp};
pub use service::{
    TODO_WRITE_EVENT, TODO_WRITE_VERSION, TodoConfig, TodoCounts, TodoError, TodoErrorCode,
    TodoItem, TodoService, TodoStatus, TodoView, TodoWrite, counts_of, decode_todo_write,
    fold_todos, todo_write_event, validate_todos,
};
