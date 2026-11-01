//! `heddle-todo` — a session's task list: durable `todo/write` snapshots, the fold, the model's one tool,
//! and the route the Web UI's dock reads.
//!
//! Ported from the TypeScript build: `src/todo/service.ts`, `src/todo/tool.ts`, `src/plugins/todo-tool.ts`,
//! and the `GET /api/todo` branch of `src/server/web.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`)
//! by `_verifiers_/80-web-ui` (`check-todo`) and `_verifiers_/50-agentic-loop` (`check-todo-tool`); the unit
//! tests port `test/todo.test.ts`.
//!
//! # The one idea
//!
//! A todo list is not a record that is updated but an event that is appended: every write appends one
//! `todo/write` event carrying the **whole list**, and the current list is the fold of the log, last write
//! wins. The list persists across turns until it is replaced or written empty (one recorded divergence from
//! DSH, which resets it per turn). The model has no read tool, as in DSH: it knows its list from its own
//! `todo_write` arguments, and the persisted list serves the page's dock and `GET /api/todo`.
//!
//! # Seams
//!
//! - [`SessionLog`] is the port this crate needs from `heddle-session`'s store (open, read, append); it is
//!   implemented for `heddle_session::SessionStore`, so the boot passes the store itself.
//! - [`tool`] holds `todo_write` (DSH's `dsh-tool-todo`) as data and functions, with its row's required
//!   `allowParallelInProgress` ([`tool::TodoToolConfig`]); the binary's `todo-tool` adapter registers it in
//!   `heddle-tools`' registry ([`tool::ToolSpec`] and [`tool::ToolAnswer`] mirror its shapes).
//! - [`http`] answers `GET /api/todo` as status and exact bytes, so `heddle-server` mounts it in one line.

#![warn(missing_docs)]

pub mod http;
mod log;
mod service;
mod store;
#[cfg(test)]
mod test_support;
pub mod tool;

pub use log::{Clock, LogError, SessionLog, SystemClock, iso_timestamp};
pub use service::{
    TODO_EMPTY_CONTENT_MESSAGE, TODO_WRITE_EVENT, TODO_WRITE_VERSION, TodoConfig, TodoCounts,
    TodoError, TodoErrorCode, TodoItem, TodoService, TodoStatus, TodoView, TodoWrite, counts_of,
    decode_todo_write, fold_todos, todo_write_event, validate_todos,
};
