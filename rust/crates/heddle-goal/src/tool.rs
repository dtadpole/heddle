//! The model-facing goal tools, as data and functions: `create_goal`, `get_goal`, `update_goal`.
//!
//! Two policies live in the tools, where a model reads them: a long request may be **inferred** to be a goal,
//! and a **paused** goal is resumed by the person, not the model (`GOAL_TOOL_RESUME_PAUSED`). Completing or
//! blocking ends the autonomous run, which the answer says explicitly.
//!
//! [`ToolSpec`] and [`ToolAnswer`] mirror `heddle-tools`' tool spec and result until that crate's API lands.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::service::{GoalService, GoalView};

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
    todo!("heddle-goal: goal_tool_specs")
}

/// The view as the model sees it, in the tool's own key order: `{id, revision, objective, phase, activation,
/// roundsStarted, maxGoalRounds, blockedReason?, createdAt, updatedAt}`.
pub fn tool_view(view: &GoalView) -> Value {
    let _ = view;
    todo!("heddle-goal: tool_view")
}

/// What the model is told after completing (`blocked = false`) or blocking: the objective, the reason when
/// blocked, and the instruction to write the closing message now.
pub fn end_of_run(view: &GoalView, blocked: bool) -> String {
    let _ = (view, blocked);
    todo!("heddle-goal: end_of_run")
}

/// Run `create_goal`: `objective` coerced like JavaScript's `String()`, `max_goal_rounds` like `Number()`.
/// Output: [`tool_view`] as compact JSON; `data: {"goal": view}`.
pub fn run_create_goal(goals: &GoalService, session: Option<&str>, args: &Value) -> ToolAnswer {
    let _ = (goals, session, args);
    todo!("heddle-goal: run_create_goal")
}

/// Run `get_goal`: no goal → output `no goal is current in this session`, `data: {"goal": null}`.
pub fn run_get_goal(goals: &GoalService, session: Option<&str>) -> ToolAnswer {
    let _ = (goals, session);
    todo!("heddle-goal: run_get_goal")
}

/// Run `update_goal` with `action` one of `update`, `pause`, `resume`, `complete`, `blocked`. Resuming a goal
/// the model's reference names while it is paused is refused (`GOAL_TOOL_RESUME_PAUSED`); `complete` and
/// `blocked` append [`end_of_run`] to the output after a blank line.
pub fn run_update_goal(goals: &GoalService, session: Option<&str>, args: &Value) -> ToolAnswer {
    let _ = (goals, session, args);
    todo!("heddle-goal: run_update_goal")
}
