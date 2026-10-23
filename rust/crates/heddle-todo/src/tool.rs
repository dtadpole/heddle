//! The model-facing todo tools, as data and functions: `todo_write` replaces the whole list, `todo_read`
//! returns the durable one.
//!
//! [`ToolSpec`] and [`ToolAnswer`] mirror `heddle-tools`' tool spec and tool result (the TypeScript
//! `ToolDefinition['spec']` and `ToolResult`) until that crate's API lands; then these functions are wrapped
//! in its tool trait and the mirrors go.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::service::TodoService;

/// The name of the write tool.
pub const TODO_WRITE: &str = "todo_write";
/// The name of the read tool.
pub const TODO_READ: &str = "todo_read";

/// `todo_write`'s description, the TypeScript build's words.
pub const WRITE_DESCRIPTION: &str = "Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. While work remains, keep exactly one todo `in_progress`. Mark each todo `completed` as soon as it is done.";

/// `todo_read`'s description, the TypeScript build's words.
pub const READ_DESCRIPTION: &str = "Read the current session todo list. The list is durable: it survives turns and restarts until it is replaced.";

/// A tool as the model is offered it: name, description, JSON-schema parameters.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    /// The tool's name.
    pub name: String,
    /// What the model reads.
    pub description: String,
    /// The JSON schema of its arguments.
    pub parameters: Value,
}

/// A refusal in a tool answer: the stable code and the sentence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolFailure {
    /// `TODO_INVALID_LIST`, `TODO_TOOL_NO_SESSION`, `TODO_TOOL_ERROR`, …
    pub code: String,
    /// The sentence.
    pub message: String,
}

/// What a tool call answers — the TypeScript `ToolResult`: the text the model reads, an optional refusal, and
/// structured data for the views.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolAnswer {
    /// The text the model reads; empty on a refusal.
    pub output: String,
    /// Present when the call was refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolFailure>,
    /// Structured data: `{"todo": view}` or `{"todo": null}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// The two tools' specs, `todo_write` first, with the TypeScript build's schemas.
pub fn todo_tool_specs() -> Vec<ToolSpec> {
    todo!("heddle-todo: todo_tool_specs")
}

/// Run `todo_write` for `session` with the model's `args`.
///
/// No session → `TODO_TOOL_NO_SESSION`. A refused list → its code (`TODO_INVALID_LIST`) and sentence; a log
/// failure → `TODO_TOOL_ERROR`. Otherwise the output `Updated todo list: N pending, N in progress, N completed.`
/// and `data: {"todo": view}`.
pub fn run_todo_write(service: &TodoService, session: Option<&str>, args: &Value) -> ToolAnswer {
    let _ = (service, session, args);
    todo!("heddle-todo: run_todo_write")
}

/// Run `todo_read` for `session`.
///
/// No session → `TODO_TOOL_NO_SESSION`. Nothing written → output `no todo list has been written in this
/// session` and `data: {"todo": null}`; otherwise the output is `{"todos":…,"counts":…}` as compact JSON and
/// `data: {"todo": view}`.
pub fn run_todo_read(service: &TodoService, session: Option<&str>) -> ToolAnswer {
    let _ = (service, session);
    todo!("heddle-todo: run_todo_read")
}
