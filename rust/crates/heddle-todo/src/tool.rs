//! The model-facing todo tools, as data and functions: `todo_write` replaces the whole list, `todo_read`
//! returns the durable one.
//!
//! [`ToolSpec`] and [`ToolAnswer`] mirror `heddle-tools`' tool spec and tool result (the TypeScript
//! `ToolDefinition['spec']` and `ToolResult`) until that crate's API lands; then these functions are wrapped
//! in its tool trait and the mirrors go.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::service::{TodoCounts, TodoError, TodoItem, TodoService, TodoView};

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
    vec![
        ToolSpec {
            name: TODO_WRITE.to_owned(),
            description: WRITE_DESCRIPTION.to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "The COMPLETE task list, replacing any previous list.",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "content": {
                                    "type": "string",
                                    "description": "What the task is — a short imperative line."
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"],
                                    "description": "pending (not started) | in_progress (now) | completed (done)."
                                }
                            },
                            "required": ["content", "status"]
                        }
                    }
                },
                "required": ["todos"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: TODO_READ.to_owned(),
            description: READ_DESCRIPTION.to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
    ]
}

/// Run `todo_write` for `session` with the model's `args`.
///
/// No session → `TODO_TOOL_NO_SESSION`. A refused list → its code (`TODO_INVALID_LIST`) and sentence; a log
/// failure → `TODO_TOOL_ERROR`. Otherwise the output `Updated todo list: N pending, N in progress, N completed.`
/// and `data: {"todo": view}`.
pub fn run_todo_write(service: &TodoService, session: Option<&str>, args: &Value) -> ToolAnswer {
    let Some(session) = session else {
        return no_session();
    };
    let raw = args.get("todos").cloned().unwrap_or(Value::Null);
    match service.write(session, &raw) {
        Ok(view) => {
            let output = format!(
                "Updated todo list: {} pending, {} in progress, {} completed.",
                view.counts.pending, view.counts.in_progress, view.counts.completed
            );
            ToolAnswer {
                output,
                error: None,
                data: Some(json!({ "todo": view })),
            }
        }
        Err(error) => refused(error),
    }
}

/// Run `todo_read` for `session`.
///
/// No session → `TODO_TOOL_NO_SESSION`. Nothing written → output `no todo list has been written in this
/// session` and `data: {"todo": null}`; otherwise the output is `{"todos":…,"counts":…}` as compact JSON and
/// `data: {"todo": view}`.
pub fn run_todo_read(service: &TodoService, session: Option<&str>) -> ToolAnswer {
    let Some(session) = session else {
        return no_session();
    };
    match service.get(session) {
        Ok(None) => ToolAnswer {
            output: "no todo list has been written in this session".to_owned(),
            error: None,
            data: Some(json!({ "todo": null })),
        },
        Ok(Some(view)) => ToolAnswer {
            output: wire(&view),
            error: None,
            data: Some(json!({ "todo": view })),
        },
        Err(error) => refused(error),
    }
}

/// The wire shape both tools answer with, in the TypeScript key order: `{todos, counts}`.
#[derive(Serialize)]
struct Wire<'a> {
    todos: &'a [TodoItem],
    counts: TodoCounts,
}

/// The list as compact JSON, the way `JSON.stringify` writes it.
fn wire(view: &TodoView) -> String {
    serde_json::to_string(&Wire {
        todos: &view.todos,
        counts: view.counts,
    })
    .expect("a todo view is plain data")
}

/// A call with no session is refused: a list is per session, never global.
fn no_session() -> ToolAnswer {
    ToolAnswer {
        output: String::new(),
        error: Some(ToolFailure {
            code: "TODO_TOOL_NO_SESSION".to_owned(),
            message: "a todo list belongs to a session, and this call has none".to_owned(),
        }),
        data: None,
    }
}

/// A refusal keeps its stable code; a log failure is the generic tool error.
fn refused(error: TodoError) -> ToolAnswer {
    let (code, message) = match &error {
        TodoError::Invalid { code, message } => (code.as_str().to_owned(), message.clone()),
        TodoError::Log(_) => ("TODO_TOOL_ERROR".to_owned(), error.to_string()),
    };
    ToolAnswer {
        output: String::new(),
        error: Some(ToolFailure { code, message }),
        data: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::fixture;

    fn code(answer: &ToolAnswer) -> &str {
        answer.error.as_ref().expect("a refusal").code.as_str()
    }

    #[test]
    fn there_are_two_tools_with_the_typescript_specs() {
        let specs = todo_tool_specs();
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].name, TODO_WRITE);
        assert_eq!(specs[1].name, TODO_READ);
        assert_eq!(specs[0].description, WRITE_DESCRIPTION);
        assert_eq!(specs[1].description, READ_DESCRIPTION);
        assert_eq!(specs[0].parameters["required"], json!(["todos"]));
        assert_eq!(
            specs[0].parameters["properties"]["todos"]["items"]["properties"]["status"]["enum"],
            json!(["pending", "in_progress", "completed"])
        );
        assert_eq!(specs[0].parameters["additionalProperties"], false);
        assert_eq!(specs[1].parameters["properties"], json!({}));
        assert_eq!(specs[1].parameters["additionalProperties"], false);
    }

    #[test]
    fn a_call_without_a_session_is_refused_by_both_tools() {
        let (_log, service) = fixture("s1");
        let write = run_todo_write(&service, None, &json!({ "todos": [] }));
        assert_eq!(code(&write), "TODO_TOOL_NO_SESSION");
        assert_eq!(write.output, "");
        assert_eq!(
            write.error.unwrap().message,
            "a todo list belongs to a session, and this call has none"
        );
        let read = run_todo_read(&service, None);
        assert_eq!(code(&read), "TODO_TOOL_NO_SESSION");
    }

    #[test]
    fn the_write_tool_writes_the_whole_list_and_says_what_it_did() {
        let (_log, service) = fixture("s1");
        let answer = run_todo_write(
            &service,
            Some("s1"),
            &json!({"todos": [
                {"content": "first", "status": "in_progress"},
                {"content": "second", "status": "pending"}
            ]}),
        );
        assert_eq!(answer.error, None);
        assert_eq!(
            answer.output,
            "Updated todo list: 1 pending, 1 in progress, 0 completed."
        );
        let todo = &answer.data.unwrap()["todo"];
        assert_eq!(
            todo["counts"],
            json!({"pending": 1, "inProgress": 1, "completed": 0})
        );
        assert_eq!(todo["todos"][0]["content"], "first");
    }

    #[test]
    fn the_read_tool_answers_the_compact_list_and_an_absent_one_plainly() {
        let (_log, service) = fixture("s1");
        let absent = run_todo_read(&service, Some("s1"));
        assert_eq!(
            absent.output,
            "no todo list has been written in this session"
        );
        assert_eq!(absent.data.unwrap()["todo"], Value::Null);

        run_todo_write(
            &service,
            Some("s1"),
            &json!({"todos": [
                {"content": "first", "status": "in_progress"},
                {"content": "second", "status": "pending"}
            ]}),
        );
        let read = run_todo_read(&service, Some("s1"));
        assert_eq!(
            read.output,
            "{\"todos\":[{\"content\":\"first\",\"status\":\"in_progress\"},{\"content\":\"second\",\"status\":\"pending\"}],\"counts\":{\"pending\":1,\"inProgress\":1,\"completed\":0}}"
        );
        assert_eq!(read.data.unwrap()["todo"]["todos"][1]["content"], "second");
    }

    #[test]
    fn a_refused_write_keeps_its_code_and_the_list_is_untouched() {
        let (_log, service) = fixture("s1");
        let answer = run_todo_write(
            &service,
            Some("s1"),
            &json!({"todos": [
                {"content": "a", "status": "in_progress"},
                {"content": "b", "status": "in_progress"}
            ]}),
        );
        assert_eq!(code(&answer), "TODO_INVALID_LIST");
        assert_eq!(
            answer.error.unwrap().message,
            "at most one todo may be in_progress (got 2)"
        );
        assert_eq!(
            run_todo_read(&service, Some("s1")).data.unwrap()["todo"],
            Value::Null
        );
    }

    #[test]
    fn a_missing_todos_argument_is_an_invalid_list_not_a_panic() {
        let (_log, service) = fixture("s1");
        let answer = run_todo_write(&service, Some("s1"), &json!({}));
        assert_eq!(code(&answer), "TODO_INVALID_LIST");
        assert_eq!(answer.error.unwrap().message, "todos must be an array");
    }

    #[test]
    fn an_unknown_session_is_a_tool_error() {
        let (_log, service) = fixture("s1");
        let answer = run_todo_read(&service, Some("nobody"));
        assert_eq!(code(&answer), "TODO_TOOL_ERROR");
        assert_eq!(answer.error.unwrap().message, "no session nobody");
    }
}
