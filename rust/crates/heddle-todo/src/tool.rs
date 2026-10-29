//! The model-facing todo tool, ported from DSH's `dsh-tool-todo` (0.2.1-rc.2) for parity, as data and
//! functions: `todo_write` alone, the whole list replaced and answered with its counts.
//!
//! There is **no read tool**, as in DSH (R-developer-nine-10): the model knows its list from its own earlier
//! `todo_write` arguments in its history, and the answer carries only counts. The durable list still exists for
//! people — the page's dock and `GET /api/todo` read the todo service, never a tool.
//!
//! The description, the parameter descriptions and the four refusal sentences are DSH's, verbatim. A refusal
//! keeps this project's rendering, a stable code plus the message: `TODO_INVALID_LIST` for a list the rules
//! refuse, `TODO_TOOL_NO_SESSION` for a call with no owning session.
//!
//! The tool's one setting, [`TodoToolConfig`]'s `allowParallelInProgress`, is required with no default
//! (R-developer-nine-9): it picks the description's active-status clause and, only when false, the refusal of a
//! list with more than one item in progress.
//!
//! [`ToolSpec`] and [`ToolAnswer`] mirror `heddle-tools`' tool spec and tool result (the TypeScript
//! `ToolDefinition['spec']` and `ToolResult`); the binary's `todo-tool` adapter wraps these functions as
//! registry tools, so this crate needs no tools dependency.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::service::{TodoError, TodoErrorCode, TodoService, validate_todos};

/// The name of the tool.
pub const TODO_WRITE: &str = "todo_write";

/// The description's head, DSH's words.
const DESCRIPTION_HEAD: &str = "Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. ";
/// The active-status clause when several todos may be in progress, DSH's words.
const DESCRIPTION_PARALLEL: &str = "While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. ";
/// The active-status clause when one todo may be in progress, DSH's words.
const DESCRIPTION_SINGLE: &str = "While work remains, keep exactly one todo `in_progress`. ";
/// The description's tail, DSH's words.
const DESCRIPTION_TAIL: &str = "Mark each todo `completed` as soon as it is done.";

/// The refusal of a call with no owning session, DSH's sentence.
pub const TODO_NO_SESSION_MESSAGE: &str = "todo_write requires an owning agent session";

/// The `todo_write` description for one setting: HEAD, the active-status clause, TAIL.
///
/// The clause is the only part that varies, because it is the only instruction the parallel policy changes.
pub fn describe_todo_write(allow_parallel_in_progress: bool) -> String {
    let clause = if allow_parallel_in_progress {
        DESCRIPTION_PARALLEL
    } else {
        DESCRIPTION_SINGLE
    };
    format!("{DESCRIPTION_HEAD}{clause}{DESCRIPTION_TAIL}")
}

/// The tool's one setting, the `todo-tool` row's config. Serialized `{allowParallelInProgress}`.
///
/// DSH's `allowParallelInProgress`: **required, with no default**, so a profile that mounts the tool has to
/// choose. There is deliberately no `Default` and no serde default: a row without it does not load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoToolConfig {
    /// Whether several todos may be `in_progress` at once.
    pub allow_parallel_in_progress: bool,
}

/// A `todo-tool` row whose config holds no boolean `allowParallelInProgress`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the todo tool requires allowParallelInProgress, a boolean with no default")]
pub struct TodoToolConfigError;

impl TodoToolConfig {
    /// Read a `todo-tool` row's config: an object whose `allowParallelInProgress` is a boolean. Anything else
    /// — no config, an object without the key, a string or a number — is refused, as the TypeScript plugin's
    /// schema and `todoTools` refuse it. Other keys are ignored, as a Schemastery object ignores them.
    pub fn from_row(config: &Value) -> Result<Self, TodoToolConfigError> {
        config
            .get("allowParallelInProgress")
            .and_then(Value::as_bool)
            .map(|allow_parallel_in_progress| TodoToolConfig {
                allow_parallel_in_progress,
            })
            .ok_or(TodoToolConfigError)
    }
}

/// The `todo-tool` row's schema, for `config --validate`: an object that must hold the boolean
/// `allowParallelInProgress`. JSON-schema data, so the binary wraps it in its configuration schema type.
pub fn todo_tool_config_schema() -> Value {
    json!({
        "type": "object",
        "required": ["allowParallelInProgress"],
        "properties": {
            "allowParallelInProgress": {
                "type": "boolean",
                "description": "Whether several todos may be in_progress at once. Required, with no default, as in DSH."
            }
        }
    })
}

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
    /// Structured data: `{"todo": view}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// The tool's spec for one setting — `todo_write` alone, as DSH registers — with DSH's description and
/// parameter texts.
pub fn todo_tool_specs(config: &TodoToolConfig) -> Vec<ToolSpec> {
    vec![ToolSpec {
        name: TODO_WRITE.to_owned(),
        description: describe_todo_write(config.allow_parallel_in_progress),
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
    }]
}

/// Run `todo_write` under `config` for `session` with the model's `args`.
///
/// Validation first, then the owner, in DSH's order, so a bad list is refused for what it is: a refused list →
/// `TODO_INVALID_LIST` and its sentence (under the tool's own parallel policy); then no session →
/// `TODO_TOOL_NO_SESSION`, `todo_write requires an owning agent session`; a log failure → `TODO_TOOL_ERROR`.
/// Otherwise the output `Updated todo list: N pending, N in progress, N completed.` and `data: {"todo": view}`.
pub fn run_todo_write(
    service: &TodoService,
    config: &TodoToolConfig,
    session: Option<&str>,
    args: &Value,
) -> ToolAnswer {
    let allow_parallel = config.allow_parallel_in_progress;
    let raw = args.get("todos").cloned().unwrap_or(Value::Null);
    if let Err(error) = validate_todos(&raw, TodoErrorCode::InvalidList, allow_parallel) {
        return refused(error);
    }
    let Some(session) = session else {
        return no_session();
    };
    match service.write_with_policy(session, &raw, allow_parallel) {
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

/// A call with no owning session is refused: a list is per session, never global.
fn no_session() -> ToolAnswer {
    ToolAnswer {
        output: String::new(),
        error: Some(ToolFailure {
            code: "TODO_TOOL_NO_SESSION".to_owned(),
            message: TODO_NO_SESSION_MESSAGE.to_owned(),
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

    const PARALLEL: TodoToolConfig = TodoToolConfig {
        allow_parallel_in_progress: true,
    };
    const SINGLE: TodoToolConfig = TodoToolConfig {
        allow_parallel_in_progress: false,
    };

    const HEAD: &str = "Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. ";
    const TAIL: &str = "Mark each todo `completed` as soon as it is done.";

    /// The one tool the todo tool offers, for a setting.
    fn write_spec(config: &TodoToolConfig) -> ToolSpec {
        let mut specs = todo_tool_specs(config);
        assert_eq!(specs.len(), 1, "one tool, as DSH registers");
        let spec = specs.remove(0);
        assert_eq!(spec.name, "todo_write");
        spec
    }

    fn failure(answer: &ToolAnswer) -> (&str, &str) {
        let error = answer.error.as_ref().expect("a refusal");
        (error.code.as_str(), error.message.as_str())
    }

    #[test]
    fn the_todo_tool_offers_todo_write_alone_there_is_no_todo_read() {
        for config in [PARALLEL, SINGLE] {
            let names: Vec<String> = todo_tool_specs(&config)
                .into_iter()
                .map(|spec| spec.name)
                .collect();
            assert_eq!(
                names,
                ["todo_write"],
                "the model knows its list from its own todo_write arguments, as in DSH"
            );
        }
    }

    #[test]
    fn the_description_is_dsh_head_the_clause_the_setting_selects_and_tail() {
        let parallel = "While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. ";
        let single = "While work remains, keep exactly one todo `in_progress`. ";
        assert_eq!(describe_todo_write(true), format!("{HEAD}{parallel}{TAIL}"));
        assert_eq!(describe_todo_write(false), format!("{HEAD}{single}{TAIL}"));
        assert_eq!(
            write_spec(&PARALLEL).description,
            format!("{HEAD}{parallel}{TAIL}"),
            "true: several only when work runs in parallel"
        );
        assert_eq!(
            write_spec(&SINGLE).description,
            format!("{HEAD}{single}{TAIL}"),
            "false: exactly one"
        );
    }

    #[test]
    fn the_parameter_descriptions_are_dsh_verbatim() {
        let parameters = write_spec(&PARALLEL).parameters;
        assert_eq!(parameters["required"], json!(["todos"]));
        assert_eq!(parameters["additionalProperties"], false);
        let list = &parameters["properties"]["todos"];
        assert_eq!(
            list["description"],
            "The COMPLETE task list, replacing any previous list."
        );
        assert_eq!(list["items"]["additionalProperties"], false);
        assert_eq!(list["items"]["required"], json!(["content", "status"]));
        let properties = &list["items"]["properties"];
        assert_eq!(
            properties["content"]["description"],
            "What the task is — a short imperative line."
        );
        assert_eq!(
            properties["status"]["description"],
            "pending (not started) | in_progress (now) | completed (done)."
        );
        assert_eq!(
            properties["status"]["enum"],
            json!(["pending", "in_progress", "completed"])
        );
    }

    #[test]
    fn the_setting_is_required_with_no_default() {
        for bad in [
            Value::Null,
            json!({}),
            json!({ "allowParallelInProgress": "true" }),
            json!({ "allowParallelInProgress": 1 }),
            json!({ "allowParallelInProgress": null }),
            json!(true),
        ] {
            let error = TodoToolConfig::from_row(&bad).unwrap_err();
            assert!(
                error.to_string().contains("allowParallelInProgress"),
                "refused: {bad}"
            );
            assert_eq!(
                error.to_string(),
                "the todo tool requires allowParallelInProgress, a boolean with no default"
            );
        }
        assert_eq!(
            TodoToolConfig::from_row(&json!({ "allowParallelInProgress": true })),
            Ok(PARALLEL)
        );
        assert_eq!(
            TodoToolConfig::from_row(&json!({ "allowParallelInProgress": false })),
            Ok(SINGLE)
        );
        assert!(
            serde_json::from_value::<TodoToolConfig>(json!({})).is_err(),
            "no serde default either"
        );
    }

    #[test]
    fn the_row_schema_requires_the_boolean() {
        let schema = heddle_config::Schema::from_json(todo_tool_config_schema())
            .expect("the schema is a configuration schema");
        let problems = |value: Value| -> Vec<String> {
            schema
                .check(&value)
                .iter()
                .map(ToString::to_string)
                .collect()
        };
        assert_eq!(problems(json!({})), ["allowParallelInProgress is required"]);
        assert_eq!(
            problems(json!({ "allowParallelInProgress": "yes" })).len(),
            1,
            "a non-boolean is a problem"
        );
        assert!(problems(json!({ "allowParallelInProgress": true })).is_empty());
        assert!(problems(json!({ "allowParallelInProgress": false })).is_empty());
    }

    #[test]
    fn the_model_writes_the_list_through_the_tool_answered_with_the_counts() {
        let (_log, service) = fixture("s1");
        let answer = run_todo_write(
            &service,
            &SINGLE,
            Some("s1"),
            &json!({"todos": [
                {"content": "first", "status": "in_progress"},
                {"content": "second", "status": "pending"}
            ]}),
        );
        assert_eq!(answer.error, None);
        assert_eq!(
            answer.output, "Updated todo list: 1 pending, 1 in progress, 0 completed.",
            "DSH result sentence"
        );
        let todo = &answer.data.unwrap()["todo"];
        assert_eq!(
            todo["counts"],
            json!({"pending": 1, "inProgress": 1, "completed": 0})
        );
        let stored = service.get("s1").unwrap().expect("the written list");
        assert_eq!(
            serde_json::to_value(&stored.todos).unwrap(),
            json!([
                {"content": "first", "status": "in_progress"},
                {"content": "second", "status": "pending"}
            ])
        );
    }

    #[test]
    fn two_in_progress_are_accepted_when_true_and_refused_only_when_false() {
        let two = json!({"todos": [
            {"content": "a", "status": "in_progress"},
            {"content": "b", "status": "in_progress"},
            {"content": "c", "status": "completed"}
        ]});

        // The fixture's service keeps its own one-in-progress default: the tool's setting is what applies.
        let (_log, parallel) = fixture("s1");
        let accepted = run_todo_write(&parallel, &PARALLEL, Some("s1"), &two);
        assert_eq!(accepted.error, None);
        assert_eq!(
            accepted.output,
            "Updated todo list: 0 pending, 2 in progress, 1 completed."
        );
        assert_eq!(
            parallel.get("s1").unwrap().unwrap().counts.in_progress,
            2,
            "the durable list keeps both"
        );

        let (_log, single) = fixture("s1");
        let refused = run_todo_write(&single, &SINGLE, Some("s1"), &two);
        assert_eq!(
            failure(&refused),
            (
                "TODO_INVALID_LIST",
                "invalid todos: at most one task may be in_progress (got 2)"
            )
        );
        assert_eq!(refused.output, "");
        assert_eq!(
            single.get("s1").unwrap(),
            None,
            "a refused write appends nothing"
        );
    }

    #[test]
    fn the_tool_refuses_with_dsh_sentences_under_either_setting() {
        for config in [PARALLEL, SINGLE] {
            let (_log, service) = fixture("s1");
            let empty = run_todo_write(
                &service,
                &config,
                Some("s1"),
                &json!({"todos": [{"content": "  ", "status": "pending"}]}),
            );
            assert_eq!(
                failure(&empty),
                (
                    "TODO_INVALID_LIST",
                    "invalid todo: `content` must be a non-empty string"
                )
            );
            let duplicate = run_todo_write(
                &service,
                &config,
                Some("s1"),
                &json!({"todos": [
                    {"content": "same", "status": "pending"},
                    {"content": "same ", "status": "pending"}
                ]}),
            );
            assert_eq!(
                failure(&duplicate),
                (
                    "TODO_INVALID_LIST",
                    "invalid todos: duplicate content \"same\""
                )
            );
            assert_eq!(service.get("s1").unwrap(), None);
        }
    }

    #[test]
    fn a_call_with_no_owning_session_is_refused_after_validation() {
        let (_log, service) = fixture("s1");
        let no_session = run_todo_write(&service, &PARALLEL, None, &json!({ "todos": [] }));
        assert_eq!(
            failure(&no_session),
            (
                "TODO_TOOL_NO_SESSION",
                "todo_write requires an owning agent session"
            )
        );
        assert_eq!(no_session.output, "");
        let invalid_first = run_todo_write(
            &service,
            &PARALLEL,
            None,
            &json!({"todos": [{"content": "", "status": "pending"}]}),
        );
        assert_eq!(
            failure(&invalid_first),
            (
                "TODO_INVALID_LIST",
                "invalid todo: `content` must be a non-empty string"
            ),
            "validation runs before the session check"
        );
    }

    #[test]
    fn a_missing_todos_argument_is_an_invalid_list_not_a_panic() {
        let (_log, service) = fixture("s1");
        let answer = run_todo_write(&service, &SINGLE, Some("s1"), &json!({}));
        assert_eq!(
            failure(&answer),
            ("TODO_INVALID_LIST", "todos must be an array")
        );
    }

    #[test]
    fn an_unknown_session_is_a_tool_error() {
        let (_log, service) = fixture("s1");
        let answer = run_todo_write(&service, &SINGLE, Some("nobody"), &json!({ "todos": [] }));
        assert_eq!(failure(&answer), ("TODO_TOOL_ERROR", "no session nobody"));
    }
}
