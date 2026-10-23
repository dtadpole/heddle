//! The model-facing goal tools, as data and functions: `create_goal`, `get_goal`, `update_goal`.
//!
//! Two policies live in the tools, where a model reads them: a long request may be **inferred** to be a goal,
//! and a **paused** goal is resumed by the person, not the model (`GOAL_TOOL_RESUME_PAUSED`). Completing or
//! blocking ends the autonomous run, which the answer says explicitly.
//!
//! [`ToolSpec`] and [`ToolAnswer`] mirror `heddle-tools`' tool spec and result until that crate's API lands.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::service::{
    CreateGoal, EditGoal, GoalActivation, GoalBlockReason, GoalError, GoalPhase,
    GoalPhase as Phase, GoalRef, GoalService, GoalView,
};

/// The name of the create tool.
pub const CREATE_GOAL: &str = "create_goal";
/// The name of the read tool.
pub const GET_GOAL: &str = "get_goal";
/// The name of the update tool.
pub const UPDATE_GOAL: &str = "update_goal";

/// `create_goal`'s description, the TypeScript build's words.
pub const CREATE_DESCRIPTION: &str = "Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say \"goal\"; not for single-turn work.";
/// `get_goal`'s description.
pub const GET_DESCRIPTION: &str =
    "Read the current session goal, including the id and revision that update_goal requires.";
/// `update_goal`'s description.
pub const UPDATE_DESCRIPTION: &str = "Update the current goal: change its objective or round cap, pause it, resume it, mark it complete, or mark it blocked with a reason. Completion and blocking end the autonomous run.";

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
    /// A `GOAL_*` code, `GOAL_TOOL_NO_SESSION`, `GOAL_TOOL_RESUME_PAUSED`, `GOAL_TOOL_UNKNOWN_ACTION` or
    /// `GOAL_TOOL_ERROR`.
    pub code: String,
    /// The sentence.
    pub message: String,
}

/// What a tool call answers — the TypeScript `ToolResult`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolAnswer {
    /// The text the model reads; empty on a refusal.
    pub output: String,
    /// Present when the call was refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolFailure>,
    /// Structured data: `{"goal": view}` or `{"goal": null}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// The three tools' specs, in the order `create_goal`, `get_goal`, `update_goal`, with the TypeScript schemas.
pub fn goal_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: CREATE_GOAL.to_owned(),
            description: CREATE_DESCRIPTION.to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "objective": {
                        "type": "string",
                        "description": "The concrete completion objective inferred from the direct human request."
                    },
                    "max_goal_rounds": {
                        "type": "integer",
                        "description": "Optional cap on automatic continuation rounds. Defaults to 100; name a number only when the owner asked for one."
                    }
                },
                "required": ["objective"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: GET_GOAL.to_owned(),
            description: GET_DESCRIPTION.to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: UPDATE_GOAL.to_owned(),
            description: UPDATE_DESCRIPTION.to_owned(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "goal_id": {"type": "string", "description": "The goal id returned by get_goal."},
                    "revision": {"type": "integer", "description": "The exact positive revision returned by get_goal."},
                    "action": {
                        "type": "string",
                        "enum": ["update", "pause", "resume", "complete", "blocked"],
                        "description": "What to do with the goal."
                    },
                    "objective": {"type": "string", "description": "For \"update\": the new objective."},
                    "max_goal_rounds": {"type": "integer", "description": "For \"update\": the new round cap."},
                    "blocked_reason": {
                        "type": "object",
                        "description": "For \"blocked\": the stable code and the message a person reads.",
                        "properties": {
                            "code": {"type": "string"},
                            "message": {"type": "string"}
                        },
                        "required": ["code", "message"],
                        "additionalProperties": false
                    }
                },
                "required": ["goal_id", "revision", "action"],
                "additionalProperties": false
            }),
        },
    ]
}

/// The view in the tool's own key order, so the model's text matches the TypeScript build's bytes.
#[derive(Serialize)]
struct OrderedToolView<'a> {
    id: &'a str,
    revision: u64,
    objective: &'a str,
    phase: Phase,
    activation: GoalActivation,
    #[serde(rename = "roundsStarted")]
    rounds_started: u64,
    #[serde(rename = "maxGoalRounds")]
    max_goal_rounds: u64,
    #[serde(rename = "blockedReason", skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<&'a GoalBlockReason>,
    #[serde(rename = "createdAt")]
    created_at: &'a str,
    #[serde(rename = "updatedAt")]
    updated_at: &'a str,
}

fn ordered(view: &GoalView) -> OrderedToolView<'_> {
    OrderedToolView {
        id: &view.goal.id,
        revision: view.goal.revision,
        objective: &view.goal.objective,
        phase: view.goal.phase,
        activation: view.activation,
        rounds_started: view.rounds_started,
        max_goal_rounds: view.goal.max_goal_rounds,
        blocked_reason: view.goal.blocked_reason.as_ref(),
        created_at: &view.created_at,
        updated_at: &view.updated_at,
    }
}

/// The compact JSON the model reads.
fn view_json(view: &GoalView) -> String {
    serde_json::to_string(&ordered(view)).expect("a goal view is plain data")
}

/// The view as the model sees it, in the tool's own key order: `{id, revision, objective, phase, activation,
/// roundsStarted, maxGoalRounds, blockedReason?, createdAt, updatedAt}`.
pub fn tool_view(view: &GoalView) -> Value {
    serde_json::to_value(ordered(view)).expect("a goal view is plain data")
}

/// What the model is told after completing (`blocked = false`) or blocking: the objective, the reason when
/// blocked, and the instruction to write the closing message now.
pub fn end_of_run(view: &GoalView, blocked: bool) -> String {
    let objective = serde_json::to_string(&view.goal.objective).expect("a string is plain data");
    if blocked {
        let reason = view
            .goal
            .blocked_reason
            .as_ref()
            .map(|reason| serde_json::to_string(reason).expect("a block reason is plain data"))
            .unwrap_or_else(|| "{}".to_owned());
        format!(
            "Objective: {objective}\nBlocked: {reason}\nThe goal is marked blocked and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue."
        )
    } else {
        format!(
            "Objective: {objective}\nThe goal is marked complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results."
        )
    }
}

/// Run `create_goal`: `objective` coerced like JavaScript's `String()`, `max_goal_rounds` like `Number()`.
/// Output: [`tool_view`] as compact JSON; `data: {"goal": view}`.
pub fn run_create_goal(goals: &GoalService, session: Option<&str>, args: &Value) -> ToolAnswer {
    let Some(session) = session else {
        return no_session();
    };
    let request = CreateGoal {
        objective: string_or_empty(args.get("objective")),
        max_goal_rounds: args.get("max_goal_rounds").map(number_of),
    };
    match goals.create(session, request) {
        Ok(view) => ToolAnswer {
            output: view_json(&view),
            error: None,
            data: Some(json!({ "goal": tool_view(&view) })),
        },
        Err(error) => refused(error),
    }
}

/// Run `get_goal`: no goal → output `no goal is current in this session`, `data: {"goal": null}`.
pub fn run_get_goal(goals: &GoalService, session: Option<&str>) -> ToolAnswer {
    let Some(session) = session else {
        return no_session();
    };
    match goals.get(session) {
        Ok(None) => ToolAnswer {
            output: "no goal is current in this session".to_owned(),
            error: None,
            data: Some(json!({ "goal": null })),
        },
        Ok(Some(view)) => ToolAnswer {
            output: view_json(&view),
            error: None,
            data: Some(json!({ "goal": tool_view(&view) })),
        },
        Err(error) => refused(error),
    }
}

/// Run `update_goal` with `action` one of `update`, `pause`, `resume`, `complete`, `blocked`. Resuming a goal
/// the model's reference names while it is paused is refused (`GOAL_TOOL_RESUME_PAUSED`); `complete` and
/// `blocked` append [`end_of_run`] to the output after a blank line.
pub fn run_update_goal(goals: &GoalService, session: Option<&str>, args: &Value) -> ToolAnswer {
    let Some(session) = session else {
        return no_session();
    };
    let reference = GoalRef {
        id: string_or_empty(args.get("goal_id")),
        revision: revision_of(args.get("revision")),
    };
    let action = string_or_empty(args.get("action"));
    if action == "resume" {
        // A paused goal is the person's decision: a model that could undo it would make the pause meaningless.
        if let Ok(Some(current)) = goals.get(session)
            && current.goal.id == reference.id
            && current.goal.revision == reference.revision
            && current.goal.phase == GoalPhase::Paused
        {
            return ToolAnswer {
                output: String::new(),
                error: Some(ToolFailure {
                    code: "GOAL_TOOL_RESUME_PAUSED".to_owned(),
                    message: "the model cannot resume a paused goal; the user must resume it"
                        .to_owned(),
                }),
                data: None,
            };
        }
    }
    let outcome = match action.as_str() {
        "pause" => goals.pause(session, &reference),
        "resume" => goals.resume(session, &reference),
        "complete" => goals.complete(session, &reference),
        "blocked" => goals.block(
            session,
            &reference,
            args.get("blocked_reason").unwrap_or(&Value::Null),
        ),
        "update" => goals.edit(
            session,
            &reference,
            EditGoal {
                objective: args.get("objective").map(js_string),
                max_goal_rounds: args.get("max_goal_rounds").map(number_of),
            },
        ),
        other => {
            return ToolAnswer {
                output: String::new(),
                error: Some(ToolFailure {
                    code: "GOAL_TOOL_UNKNOWN_ACTION".to_owned(),
                    message: format!(
                        "unknown goal action {}",
                        serde_json::to_string(other).expect("a string is plain data")
                    ),
                }),
                data: None,
            };
        }
    };
    match outcome {
        Ok(view) => {
            let ended = action == "complete" || action == "blocked";
            let mut output = view_json(&view);
            if ended {
                output.push_str("\n\n");
                output.push_str(&end_of_run(&view, action == "blocked"));
            }
            ToolAnswer {
                output,
                error: None,
                data: Some(json!({ "goal": tool_view(&view) })),
            }
        }
        Err(error) => refused(error),
    }
}

/// A call with no session is refused: a goal is per session, never global.
fn no_session() -> ToolAnswer {
    ToolAnswer {
        output: String::new(),
        error: Some(ToolFailure {
            code: "GOAL_TOOL_NO_SESSION".to_owned(),
            message: "a goal belongs to a session, and this call has none".to_owned(),
        }),
        data: None,
    }
}

/// A refusal keeps its stable code; a log failure is the generic tool error.
fn refused(error: GoalError) -> ToolAnswer {
    let (code, message) = match &error {
        GoalError::Refused { code, message } => (code.as_str().to_owned(), message.clone()),
        GoalError::Log(_) => ("GOAL_TOOL_ERROR".to_owned(), error.to_string()),
    };
    ToolAnswer {
        output: String::new(),
        error: Some(ToolFailure { code, message }),
        data: None,
    }
}

/// JavaScript's `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript's `String(value ?? '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

/// JavaScript's `Number(value)`.
fn number_of(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::Array(items) => match items.as_slice() {
            [] => 0.0,
            [one] => number_of(one),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(value)` as a revision; anything that is not a positive integer becomes 0, which matches no goal.
fn revision_of(value: Option<&Value>) -> u64 {
    let Some(value) = value else {
        return 0;
    };
    let number = number_of(value);
    if number.is_finite()
        && number.fract() == 0.0
        && (1.0..=9_007_199_254_740_991.0).contains(&number)
    {
        number as u64
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::test_support::fixture;

    #[test]
    fn there_are_three_tools_with_the_typescript_specs() {
        let specs = goal_tool_specs();
        assert_eq!(specs.len(), 3);
        assert_eq!(specs[0].name, CREATE_GOAL);
        assert_eq!(specs[1].name, GET_GOAL);
        assert_eq!(specs[2].name, UPDATE_GOAL);
        assert_eq!(specs[0].description, CREATE_DESCRIPTION);
        assert_eq!(specs[0].parameters["required"], json!(["objective"]));
        assert_eq!(specs[1].parameters["properties"], json!({}));
        assert_eq!(
            specs[2].parameters["properties"]["action"]["enum"],
            json!(["update", "pause", "resume", "complete", "blocked"])
        );
        assert_eq!(
            specs[2].parameters["required"],
            json!(["goal_id", "revision", "action"])
        );
    }

    #[test]
    fn a_call_without_a_session_is_refused_by_all_three() {
        let (_log, goals) = fixture("s1");
        for answer in [
            run_create_goal(&goals, None, &json!({"objective": "x"})),
            run_get_goal(&goals, None),
            run_update_goal(&goals, None, &json!({})),
        ] {
            assert_eq!(answer.error.unwrap().code, "GOAL_TOOL_NO_SESSION");
        }
    }

    #[test]
    fn the_create_tool_creates_and_the_read_tool_reads_it_back() {
        let (_log, goals) = fixture("s1");
        let created = run_create_goal(
            &goals,
            Some("s1"),
            &json!({"objective": "finish the goal feature", "max_goal_rounds": 6}),
        );
        assert_eq!(created.error, None);
        let view: Value = serde_json::from_str(&created.output).unwrap();
        assert_eq!(view["phase"], "active");
        assert_eq!(view["maxGoalRounds"], 6);
        assert_eq!(view["activation"], "armed");
        assert_eq!(view["roundsStarted"], 0);
        assert_eq!(created.data.unwrap()["goal"]["id"], view["id"]);

        let read = run_get_goal(&goals, Some("s1"));
        let read_view: Value = serde_json::from_str(&read.output).unwrap();
        assert_eq!(read_view["id"], view["id"]);
    }

    #[test]
    fn a_session_without_a_goal_reads_as_null() {
        let (_log, goals) = fixture("s1");
        let answer = run_get_goal(&goals, Some("s1"));
        assert_eq!(answer.output, "no goal is current in this session");
        assert_eq!(answer.data.unwrap()["goal"], Value::Null);
    }

    fn created_view(goals: &GoalService) -> Value {
        serde_json::from_str(
            &run_create_goal(goals, Some("s1"), &json!({"objective": "one"})).output,
        )
        .unwrap()
    }

    #[test]
    fn the_update_tool_pauses_an_active_goal_and_refuses_to_resume_a_paused_one() {
        let (_log, goals) = fixture("s1");
        let view = created_view(&goals);
        let paused = run_update_goal(
            &goals,
            Some("s1"),
            &json!({"goal_id": view["id"], "revision": view["revision"], "action": "pause"}),
        );
        assert_eq!(paused.error, None);
        let paused: Value = serde_json::from_str(&paused.output).unwrap();
        assert_eq!(paused["phase"], "paused");
        assert_eq!(paused["activation"], "disarmed");

        let refused = run_update_goal(
            &goals,
            Some("s1"),
            &json!({"goal_id": paused["id"], "revision": paused["revision"], "action": "resume"}),
        );
        assert_eq!(refused.error.unwrap().code, "GOAL_TOOL_RESUME_PAUSED");
    }

    #[test]
    fn the_update_tool_resumes_an_active_but_disarmed_goal() {
        let (_log, goals) = fixture("s1");
        let view = created_view(&goals);
        goals.disarm("s1").unwrap();
        let resumed = run_update_goal(
            &goals,
            Some("s1"),
            &json!({"goal_id": view["id"], "revision": view["revision"], "action": "resume"}),
        );
        assert_eq!(resumed.error, None);
        let resumed: Value = serde_json::from_str(&resumed.output).unwrap();
        assert_eq!(resumed["phase"], "active");
        assert_eq!(resumed["activation"], "armed");
        assert_eq!(resumed["revision"], 2);
    }

    #[test]
    fn an_update_edits_the_objective_and_the_cap() {
        let (_log, goals) = fixture("s1");
        let view = created_view(&goals);
        let updated = run_update_goal(
            &goals,
            Some("s1"),
            &json!({
                "goal_id": view["id"],
                "revision": view["revision"],
                "action": "update",
                "objective": "a better objective",
                "max_goal_rounds": 9
            }),
        );
        assert_eq!(updated.error, None);
        let updated: Value = serde_json::from_str(&updated.output).unwrap();
        assert_eq!(updated["objective"], "a better objective");
        assert_eq!(updated["maxGoalRounds"], 9);
    }

    #[test]
    fn complete_and_blocked_end_the_run_and_say_so() {
        let (_log, goals) = fixture("s1");
        let view = created_view(&goals);
        let done = run_update_goal(
            &goals,
            Some("s1"),
            &json!({"goal_id": view["id"], "revision": view["revision"], "action": "complete"}),
        );
        assert_eq!(done.error, None);
        assert!(done.output.contains("The goal is marked complete"));
        assert!(
            done.output
                .contains("Write the closing message to the user now")
        );
        assert!(done.output.contains("\n\nObjective: "));

        let (second_log, second) = fixture("s2");
        second_log.create("s2");
        let view: Value = serde_json::from_str(
            &run_create_goal(&second, Some("s2"), &json!({"objective": "one"})).output,
        )
        .unwrap();
        let blocked = run_update_goal(
            &second,
            Some("s2"),
            &json!({
                "goal_id": view["id"],
                "revision": view["revision"],
                "action": "blocked",
                "blocked_reason": {"code": "missing-input", "message": "needs a key"}
            }),
        );
        assert_eq!(blocked.error, None);
        assert!(blocked.output.contains("The goal is marked blocked"));
        assert!(blocked.output.contains("\"missing-input\""));
        assert!(blocked.output.contains("needs a key"));
    }

    #[test]
    fn an_unknown_action_is_refused_with_its_name() {
        let (_log, goals) = fixture("s1");
        let answer = run_update_goal(
            &goals,
            Some("s1"),
            &json!({"goal_id": "goal-x", "revision": 1, "action": "dance"}),
        );
        assert_eq!(
            answer.error.as_ref().unwrap().code,
            "GOAL_TOOL_UNKNOWN_ACTION"
        );
        assert!(answer.error.as_ref().unwrap().message.contains("\"dance\""));
    }

    #[test]
    fn a_stale_revision_keeps_its_service_code() {
        let (_log, goals) = fixture("s1");
        let view = created_view(&goals);
        let answer = run_update_goal(
            &goals,
            Some("s1"),
            &json!({"goal_id": view["id"], "revision": 99, "action": "pause"}),
        );
        assert_eq!(answer.error.unwrap().code, "GOAL_STALE_REVISION");
    }

    #[test]
    fn the_end_of_run_says_what_ended() {
        let (_log, goals) = fixture("s1");
        let view = goals
            .create(
                "s1",
                CreateGoal {
                    objective: "ship \"it\"".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        let complete = end_of_run(&view, false);
        assert!(complete.starts_with("Objective: \"ship \\\"it\\\"\"\n"));
        assert!(complete.contains("The goal is marked complete"));
        let blocked = end_of_run(&view, true);
        assert!(blocked.contains("Blocked: {}"), "saw: {blocked}");
    }
}
