//! The model-facing goal tools, as data and functions: `create_goal`, `get_goal`, `update_goal` — DSH's
//! `dsh-tool-goal` (0.2.1-rc.2), as the TypeScript build's `src/goal/tool.ts` ports it (the DSH-parity spec
//! `goals-todo-spec.md`, section A; R-developer-nine-2, -3, -4).
//!
//! Three tools rather than one, and the split is the point:
//!
//! - `create_goal` — a long-running request becomes a persisted goal. DSH's own description says the intent may be
//!   **inferred** from the request in any language, and that single-turn work is not a goal.
//! - `get_goal` — read the current goal, including the `id` and `revision` every mutation needs.
//! - `update_goal` — `edit`, `pause`, `resume`, `complete` or `blocked`, each a compare-and-set against that ref.
//!
//! **Who may ask** is decided here, at execution, from the session's own log (DSH's `authority.js`):
//!
//! - `create_goal`, and `edit`, `pause` and `resume`, need a **direct human turn**: a top-level session (its
//!   metadata names no delegation depth, or depth 0) whose open turn holds a person's message. A person's message is
//!   written with no `source`; everything the harness writes carries one (a goal round, a reminder, team mail, a
//!   child's settlement notice), so a turn the harness started never borrows a person's authority.
//! - `complete` and `blocked` need a direct human turn **or the current goal round**: the driver's message in the
//!   open turn with `source = {kind:"goal", goalId, revision, round}` matching the goal's id, revision and
//!   `roundsStarted`. An edit mid-round bumps the revision, so that round loses the authority.
//! - A goal round may not mark the goal `blocked` before `blockedAfterConsecutiveRounds` rounds have started
//!   (default 3); a person may at once.
//! - A **paused** goal is the person's decision, so the model cannot resume it; it may re-arm an active but disarmed
//!   goal, or resume a blocked one, when a person asks.
//!
//! Only a goal round's terminal verb is told to end the run: the closing instruction is DSH's deferred
//! `<goal_complete>` / `<goal_blocked>` notice, appended to the tool's answer because heddle's tool context has no
//! deferred-context hook. A person's own `complete` or `blocked` ends nothing, as in DSH.
//!
//! [`ToolSpec`] and [`ToolAnswer`] mirror `heddle-tools`' tool spec and result until that crate's API lands.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::service::{
    CreateGoal, EditGoal, GoalActivation, GoalBlockReason, GoalError, GoalPhase, GoalRef,
    GoalService, GoalView,
};

/// The name of the create tool.
pub const CREATE_GOAL: &str = "create_goal";
/// The name of the read tool.
pub const GET_GOAL: &str = "get_goal";
/// The name of the update tool.
pub const UPDATE_GOAL: &str = "update_goal";

/// `create_goal`'s description, DSH's words.
pub const CREATE_DESCRIPTION: &str = "Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say \"goal\"; not for single-turn work.";
/// `get_goal`'s description.
pub const GET_DESCRIPTION: &str =
    "Read the current session goal, including the id and revision that update_goal requires.";
/// `update_goal`'s description, DSH's.
pub const UPDATE_DESCRIPTION: &str = "Update the current goal.";
/// The description of `update_goal`'s `action` parameter, DSH's.
pub const ACTION_DESCRIPTION: &str = "edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.";

/// The `update_goal` verbs, exactly DSH's (dsh-tool-goal:116-122), in the order the schema offers them.
pub const UPDATE_ACTIONS: [&str; 5] = ["edit", "pause", "resume", "complete", "blocked"];

/// One `update_goal` verb.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UpdateAction {
    /// Replace the objective and/or the cap.
    Edit,
    /// `active` → `paused`.
    Pause,
    /// Re-arm or resume the goal.
    Resume,
    /// Mark the goal complete.
    Complete,
    /// Mark the goal blocked with a reason.
    Blocked,
}

/// Verbs an older schema offered, accepted but never advertised.
///
/// Heddle's first schema named the edit verb `update`. A session that ran under it holds `update_goal` calls with
/// `action: "update"`, and a model reading that history imitates it; refusing the old spelling would turn a working
/// habit into a failed call for no gain. It is not in the enum, so nothing new is taught to use it.
const LEGACY_ACTIONS: [(&str, UpdateAction); 1] = [("update", UpdateAction::Edit)];

impl UpdateAction {
    /// The verb's name in the schema.
    pub const fn as_str(self) -> &'static str {
        match self {
            UpdateAction::Edit => "edit",
            UpdateAction::Pause => "pause",
            UpdateAction::Resume => "resume",
            UpdateAction::Complete => "complete",
            UpdateAction::Blocked => "blocked",
        }
    }

    /// The verb a name selects: one of [`UPDATE_ACTIONS`], or a legacy spelling (`update` is `edit`). An exact
    /// match on a fixed table, so no other name — `toString`, `__proto__` — resolves to a verb.
    pub fn parse(name: &str) -> Option<UpdateAction> {
        let known = match name {
            "edit" => Some(UpdateAction::Edit),
            "pause" => Some(UpdateAction::Pause),
            "resume" => Some(UpdateAction::Resume),
            "complete" => Some(UpdateAction::Complete),
            "blocked" => Some(UpdateAction::Blocked),
            _ => None,
        };
        known.or_else(|| {
            LEGACY_ACTIONS
                .iter()
                .find(|(legacy, _)| *legacy == name)
                .map(|(_, action)| *action)
        })
    }
}

/// The default block threshold, DSH's.
pub const DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS: u64 = 3;

/// Configuration of the goal tools: DSH's `tool-goal` config, as the TypeScript `GoalToolConfig` declares it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GoalToolConfig {
    /// Goal rounds that must have started before a goal round may mark its goal `blocked`.
    ///
    /// DSH's `blockedAfterConsecutiveRounds`, a positive safe integer defaulting to 3. Counted as the goal's
    /// `roundsStarted`, which edit, pause, resume and block keep, so "consecutive" is DSH's name rather than a
    /// tracked streak. It binds only goal-round authority: a person may mark a goal blocked at once. A JavaScript
    /// number, so `1.5` or `2⁵³` is refused by [`resolve_goal_tool_config`] rather than truncated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_after_consecutive_rounds: Option<f64>,
}

/// The goal tools' settings once [`resolve_goal_tool_config`] has validated them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GoalToolSettings {
    /// See [`GoalToolConfig::blocked_after_consecutive_rounds`].
    pub blocked_after_consecutive_rounds: u64,
}

impl Default for GoalToolSettings {
    fn default() -> Self {
        Self {
            blocked_after_consecutive_rounds: DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS,
        }
    }
}

/// A configuration DSH's `resolveConfig` refuses — the TypeScript build's `TypeError`, with its sentence.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("blockedAfterConsecutiveRounds must be a positive safe integer")]
pub struct GoalToolConfigError;

/// Validate the config even when a caller skips the schema, as DSH's `resolveConfig` does.
pub fn resolve_goal_tool_config(
    config: &GoalToolConfig,
) -> Result<GoalToolSettings, GoalToolConfigError> {
    let blocked_after = config
        .blocked_after_consecutive_rounds
        .unwrap_or(DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS as f64);
    if !is_safe_integer(blocked_after) || blocked_after < 1.0 {
        return Err(GoalToolConfigError);
    }
    Ok(GoalToolSettings {
        blocked_after_consecutive_rounds: blocked_after as u64,
    })
}

/// DSH's `tool:goal` system-prompt section, with the deployment's block threshold.
///
/// Public for the layer that assembles the system prompt: heddle has no per-tool prompt section, so the tools cannot
/// install it themselves.
pub fn goal_tool_guidance(blocked_after: u64) -> String {
    format!(
        "create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least {blocked_after} consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked."
    )
}

/// DSH's refusal sentences, verbatim (dsh-tool-goal:64, 79, 214, 344-360); the model reads them back.
pub mod messages {
    /// `create_goal`, `edit`, `pause` and `resume` outside a direct human turn.
    pub const HUMAN_REQUIRED: &str =
        "this goal operation requires a direct human turn on a top-level agent";
    /// `complete` and `blocked` outside a direct human turn and the goal's current round.
    pub const COMPLETION_AUTHORITY: &str =
        "complete and blocked require a direct human turn or the current goal round";
    /// `resume` of a goal a person paused.
    pub const RESUME_PAUSED: &str =
        "the model cannot resume a paused goal; the user must resume it";
    /// A `goal_id` or `revision` that cannot be a compare-and-set ref.
    pub const BAD_REF: &str =
        "goal_id must be non-empty and revision must be a positive safe integer";
    /// `blocked_reason` given to `edit` or `complete`.
    pub const REASON_ONLY_WITH_BLOCKED: &str = "blocked_reason is valid only with action blocked";
    /// `objective` or `max_goal_rounds` given to `complete` or `blocked`.
    pub const FIELDS_ONLY_WITH_EDIT: &str =
        "objective and max_goal_rounds are valid only with action edit";
    /// Any of the three fields given to `pause` or `resume`.
    pub const PAUSE_RESUME_FIELDS: &str = "objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked";
    /// `blocked` without a non-blank string reason.
    pub const REASON_REQUIRED: &str = "blocked_reason is required with action blocked";

    /// A goal round's `blocked` before the threshold.
    pub fn block_threshold(blocked_after: u64, rounds_started: u64) -> String {
        format!(
            "blocked requires at least {blocked_after} consecutive goal rounds; current round is {rounds_started}"
        )
    }
}

/// The stable codes of the refusals the tools decide (the domain's are the `GOAL_*` codes of
/// [`crate::GoalErrorCode`]).
pub mod codes {
    /// The call lacks the authority its verb needs.
    pub const AUTHORITY_REQUIRED: &str = "GOAL_TOOL_AUTHORITY_REQUIRED";
    /// A malformed ref, or a field the verb does not take, or a missing reason.
    pub const INVALID_UPDATE: &str = "GOAL_TOOL_INVALID_UPDATE";
    /// A verb outside the enum.
    pub const UNKNOWN_ACTION: &str = "GOAL_TOOL_UNKNOWN_ACTION";
    /// The model tried to resume a paused goal.
    pub const RESUME_PAUSED: &str = "GOAL_TOOL_RESUME_PAUSED";
    /// A goal round tried to block before the threshold.
    pub const BLOCK_THRESHOLD: &str = "GOAL_TOOL_BLOCK_THRESHOLD";
    /// The call has no session.
    pub const NO_SESSION: &str = "GOAL_TOOL_NO_SESSION";
    /// Anything that is not a refusal — a session log that failed.
    pub const ERROR: &str = "GOAL_TOOL_ERROR";
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
    /// A `GOAL_*` code of the domain, or one of [`codes`].
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
    /// Structured data: `{"goal": view}` or `{"goal": null}`; a `complete` or `blocked` adds
    /// `"authority": "direct-human" | "goal-round"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// The three tools' specs, in the order `create_goal`, `get_goal`, `update_goal`, with DSH's schemas.
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
                    "goal_id": {"type": "string", "description": "Exact id returned by get_goal."},
                    "revision": {"type": "integer", "description": "Exact positive revision returned by get_goal."},
                    "action": {
                        "type": "string",
                        "enum": UPDATE_ACTIONS,
                        "description": ACTION_DESCRIPTION
                    },
                    "objective": {"type": "string", "description": "Replacement objective; valid only with action edit."},
                    "max_goal_rounds": {"type": "integer", "description": "Replacement cap; valid only with action edit."},
                    "blocked_reason": {
                        "type": "string",
                        "description": "Required only with action blocked: the concrete condition that persisted across rounds and blocks progress."
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
    phase: GoalPhase,
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

/// The closing instruction a goal round reads after its own `complete` (`blocked_reason` `None`) or `blocked` —
/// DSH's `renderWrapupContext`, verbatim. DSH defers it as a user message after the tool result; heddle appends it
/// to the result.
pub fn end_of_run(objective: &str, blocked_reason: Option<&str>) -> String {
    let heading = format!("Objective: {}\n", json_string(objective));
    match blocked_reason {
        None => format!(
            "<goal_complete>\n{heading}The goal is marked complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Note anything the user should review or do next. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_complete>"
        ),
        Some(reason) => format!(
            "<goal_blocked>\n{heading}Blocked: {}\nThe goal is marked blocked and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue. Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_blocked>",
            json_string(reason)
        ),
    }
}

// --- Authority ----------------------------------------------------------------------------------------------------

/// The events of the turn that is open now: everything after the last turn end.
///
/// Heddle writes no turn-start event; a turn ends with `turn/completed` (the loop) or `turn/failed` (a teammate's
/// failed turn), so the open turn is the suffix after the last of those. A tool runs inside a turn, so the suffix
/// holds the message that started it and any message steered into it since.
pub fn open_turn_events(events: &[Value]) -> &[Value] {
    match events.iter().rposition(|event| {
        matches!(
            event.get("type").and_then(Value::as_str),
            Some("turn/completed" | "turn/failed")
        )
    }) {
        Some(end) => &events[end + 1..],
        None => events,
    }
}

/// The `source` of a recorded user message: `None` when the event is not one, `Some(None)` for a message written
/// without a source, `Some(Some(source))` otherwise (a JSON `null` included).
fn user_message_source(event: &Value) -> Option<Option<&Value>> {
    if event.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = event.get("message")?.as_object()?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    Some(message.get("source"))
}

/// Whether a session runs at the top level: its metadata record names no delegation depth, or depth 0.
pub fn is_top_level(meta: Option<&Value>) -> bool {
    match meta.and_then(|meta| meta.get("delegationDepth")) {
        None => true,
        Some(depth) => depth.as_f64() == Some(0.0),
    }
}

/// Whether the open turn holds a person's message on a top-level session — DSH's `hasDirectHumanInput`.
///
/// A person's message carries no `source` (or DSH's explicit `{kind:"user"}`); any other source — a goal round, a
/// reminder, team mail, a child's notice, a `null` — is the harness speaking, and grants nothing.
pub fn has_direct_human_input(turn: &[Value], meta: Option<&Value>) -> bool {
    if !is_top_level(meta) {
        return false;
    }
    turn.iter().any(|event| match user_message_source(event) {
        None => false,
        Some(None) => true,
        Some(Some(source)) => {
            source.is_object() && source.get("kind").and_then(Value::as_str) == Some("user")
        }
    })
}

/// Whether the open turn is the goal's exact current round — DSH's `isMatchingGoalRound`.
pub fn is_matching_goal_round(turn: &[Value], goal: &GoalView) -> bool {
    turn.iter().any(|event| {
        let Some(Some(source)) = user_message_source(event) else {
            return false;
        };
        source.is_object()
            && source.get("kind").and_then(Value::as_str) == Some("goal")
            && source.get("goalId").and_then(Value::as_str) == Some(goal.goal.id.as_str())
            && source.get("revision").and_then(Value::as_f64) == Some(goal.goal.revision as f64)
            && source.get("round").and_then(Value::as_f64) == Some(goal.rounds_started as f64)
    })
}

/// Who authorised a `complete` or `blocked`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompletionAuthority {
    /// A person's message in the open turn of a top-level session.
    DirectHuman,
    /// The goal's exact current round, with the goal as it was read.
    GoalRound(Box<GoalView>),
}

impl CompletionAuthority {
    /// `direct-human` or `goal-round`, as the answer's data names it.
    pub const fn as_str(&self) -> &'static str {
        match self {
            CompletionAuthority::DirectHuman => "direct-human",
            CompletionAuthority::GoalRound(_) => "goal-round",
        }
    }
}

/// What one call reads to decide its authority, read once per call.
struct CallFacts {
    events: Vec<Value>,
    meta: Option<Value>,
}

impl CallFacts {
    fn read(goals: &GoalService, session: &str) -> Result<CallFacts, Refusal> {
        Ok(CallFacts {
            events: goals.session_events(session)?,
            meta: goals.session_meta(session),
        })
    }

    fn turn(&self) -> &[Value] {
        open_turn_events(&self.events)
    }

    fn direct_human(&self) -> bool {
        has_direct_human_input(self.turn(), self.meta.as_ref())
    }
}

fn require_direct_human(facts: &CallFacts) -> Result<(), Refusal> {
    if facts.direct_human() {
        return Ok(());
    }
    Err(reject(messages::HUMAN_REQUIRED, codes::AUTHORITY_REQUIRED))
}

fn completion_authority(
    goals: &GoalService,
    session: &str,
    facts: &CallFacts,
) -> Result<CompletionAuthority, Refusal> {
    if facts.direct_human() {
        return Ok(CompletionAuthority::DirectHuman);
    }
    if let Some(goal) = goals.get(session)?
        && is_matching_goal_round(facts.turn(), &goal)
    {
        return Ok(CompletionAuthority::GoalRound(Box::new(goal)));
    }
    Err(reject(
        messages::COMPLETION_AUTHORITY,
        codes::AUTHORITY_REQUIRED,
    ))
}

// --- The tools ----------------------------------------------------------------------------------------------------

/// Why a call answers with a refusal: the tools' own, or the domain's.
enum Refusal {
    Tool { code: &'static str, message: String },
    Goal(GoalError),
}

impl From<GoalError> for Refusal {
    fn from(error: GoalError) -> Self {
        Refusal::Goal(error)
    }
}

fn reject(message: impl Into<String>, code: &'static str) -> Refusal {
    Refusal::Tool {
        code,
        message: message.into(),
    }
}

impl Refusal {
    /// The tool-result shape, keeping the stable code; a log failure is the generic tool error.
    fn into_answer(self) -> ToolAnswer {
        let (code, message) = match self {
            Refusal::Tool { code, message } => (code.to_owned(), message),
            Refusal::Goal(GoalError::Refused { code, message }) => {
                (code.as_str().to_owned(), message)
            }
            Refusal::Goal(error @ GoalError::Log(_)) => {
                (codes::ERROR.to_owned(), error.to_string())
            }
        };
        ToolAnswer {
            output: String::new(),
            error: Some(ToolFailure { code, message }),
            data: None,
        }
    }
}

/// An answer carrying one goal.
fn goal_answer(view: &GoalView) -> ToolAnswer {
    ToolAnswer {
        output: view_json(view),
        error: None,
        data: Some(json!({ "goal": tool_view(view) })),
    }
}

/// Run `create_goal` in a direct human turn: `objective` coerced like JavaScript's `String()`, `max_goal_rounds`
/// like `Number()`. Output: [`tool_view`] as compact JSON; `data: {"goal": view}`.
pub fn run_create_goal(goals: &GoalService, session: Option<&str>, args: &Value) -> ToolAnswer {
    let Some(session) = session else {
        return no_session();
    };
    let run = || -> Result<ToolAnswer, Refusal> {
        require_direct_human(&CallFacts::read(goals, session)?)?;
        let view = goals.create(
            session,
            CreateGoal {
                objective: string_or_empty(args.get("objective")),
                max_goal_rounds: args.get("max_goal_rounds").map(number_of),
            },
        )?;
        Ok(goal_answer(&view))
    };
    run().unwrap_or_else(Refusal::into_answer)
}

/// Run `get_goal`, which needs no authority: no goal → output `no goal is current in this session`,
/// `data: {"goal": null}`.
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
        Ok(Some(view)) => goal_answer(&view),
        Err(error) => Refusal::from(error).into_answer(),
    }
}

/// Run `update_goal` with the default settings (a goal round may block from round 3) — what the TypeScript
/// `goal-tool` plugin registers.
pub fn run_update_goal(goals: &GoalService, session: Option<&str>, args: &Value) -> ToolAnswer {
    run_update_goal_with(goals, session, args, GoalToolSettings::default())
}

/// Run `update_goal`: `action` one of [`UPDATE_ACTIONS`] (or the legacy `update`, which is `edit`), against the
/// exact `{goal_id, revision}`.
///
/// The order is DSH's: the verb, the ref, then authority before the per-verb fields. `edit`, `pause` and `resume`
/// need a direct human turn, and resuming a goal the ref names while it is paused is refused after that
/// (`GOAL_TOOL_RESUME_PAUSED`); `complete` and `blocked` need a direct human turn or the goal's current round, and a
/// goal round may not block before `settings.blocked_after_consecutive_rounds` rounds. A `blocked_reason` is stored
/// as `{code:"model-reported", message:<trimmed>}`. Only under goal-round authority does the output append
/// [`end_of_run`] after a blank line.
pub fn run_update_goal_with(
    goals: &GoalService,
    session: Option<&str>,
    args: &Value,
    settings: GoalToolSettings,
) -> ToolAnswer {
    let Some(session) = session else {
        return no_session();
    };
    update(goals, session, args, settings).unwrap_or_else(Refusal::into_answer)
}

fn update(
    goals: &GoalService,
    session: &str,
    args: &Value,
    settings: GoalToolSettings,
) -> Result<ToolAnswer, Refusal> {
    let action = action_of(args.get("action"))?;
    let reference = goal_ref(args.get("goal_id"), args.get("revision"))?;
    let objective = args
        .get("objective")
        .filter(|value| given(Some(value)))
        .map(js_string);
    let max_goal_rounds = args
        .get("max_goal_rounds")
        .filter(|value| given(Some(value)))
        .map(number_of);
    let reason = args.get("blocked_reason");
    let facts = CallFacts::read(goals, session)?;

    match action {
        UpdateAction::Edit => {
            require_direct_human(&facts)?;
            if given(reason) {
                return Err(reject(
                    messages::REASON_ONLY_WITH_BLOCKED,
                    codes::INVALID_UPDATE,
                ));
            }
            let view = goals.edit(
                session,
                &reference,
                EditGoal {
                    objective,
                    max_goal_rounds,
                },
            )?;
            Ok(goal_answer(&view))
        }
        UpdateAction::Pause | UpdateAction::Resume => {
            require_direct_human(&facts)?;
            if objective.is_some() || max_goal_rounds.is_some() || given(reason) {
                return Err(reject(messages::PAUSE_RESUME_FIELDS, codes::INVALID_UPDATE));
            }
            if action == UpdateAction::Resume {
                // A paused goal is the person's decision to stop: a model that could undo it would make the pause
                // meaningless, even inside a person's turn. Re-arming an active-but-disarmed goal, or resuming a
                // blocked one, is allowed when a person asks.
                if let Some(current) = goals.get(session)?
                    && current.goal.id == reference.id
                    && current.goal.revision == reference.revision
                    && current.goal.phase == GoalPhase::Paused
                {
                    return Err(reject(messages::RESUME_PAUSED, codes::RESUME_PAUSED));
                }
            }
            let view = if action == UpdateAction::Pause {
                goals.pause(session, &reference)?
            } else {
                goals.resume(session, &reference)?
            };
            Ok(goal_answer(&view))
        }
        UpdateAction::Complete | UpdateAction::Blocked => {
            let authority = completion_authority(goals, session, &facts)?;
            if objective.is_some() || max_goal_rounds.is_some() {
                return Err(reject(
                    messages::FIELDS_ONLY_WITH_EDIT,
                    codes::INVALID_UPDATE,
                ));
            }
            if action == UpdateAction::Complete && given(reason) {
                return Err(reject(
                    messages::REASON_ONLY_WITH_BLOCKED,
                    codes::INVALID_UPDATE,
                ));
            }
            // The domain keeps DSH's shape for a model's report: `{code: "model-reported", message}`, trimmed.
            let message = if action == UpdateAction::Blocked {
                match reason {
                    Some(Value::String(text)) if !js_trim(text).is_empty() => {
                        Some(js_trim(text).to_owned())
                    }
                    _ => {
                        return Err(reject(messages::REASON_REQUIRED, codes::INVALID_UPDATE));
                    }
                }
            } else {
                None
            };
            if let (Some(_), CompletionAuthority::GoalRound(goal)) = (&message, &authority)
                && goal.rounds_started < settings.blocked_after_consecutive_rounds
            {
                return Err(reject(
                    messages::block_threshold(
                        settings.blocked_after_consecutive_rounds,
                        goal.rounds_started,
                    ),
                    codes::BLOCK_THRESHOLD,
                ));
            }
            let view = match &message {
                None => goals.complete(session, &reference)?,
                Some(message) => goals.block(
                    session,
                    &reference,
                    &json!({"code": "model-reported", "message": message}),
                )?,
            };
            let mut output = view_json(&view);
            // Only a goal round is told to end its run; a person's own verb ends nothing (DSH defers it only then).
            if matches!(authority, CompletionAuthority::GoalRound(_)) {
                output.push_str("\n\n");
                output.push_str(&end_of_run(&view.goal.objective, message.as_deref()));
            }
            Ok(ToolAnswer {
                output,
                error: None,
                data: Some(json!({ "goal": tool_view(&view), "authority": authority.as_str() })),
            })
        }
    }
}

/// The verb the call names, its legacy spelling resolved; anything else is refused before it runs.
fn action_of(value: Option<&Value>) -> Result<UpdateAction, Refusal> {
    let name = match value {
        Some(Value::String(text)) => text.as_str(),
        _ => "",
    };
    UpdateAction::parse(name).ok_or_else(|| {
        reject(
            format!(
                "unknown goal action {}",
                json_string(&string_or_empty(value))
            ),
            codes::UNKNOWN_ACTION,
        )
    })
}

/// The exact compare-and-set ref from the model's arguments — DSH's `goalRef`: a string id with no surrounding
/// blank, and a positive safe-integer revision (a number, or a non-blank numeric string).
fn goal_ref(goal_id: Option<&Value>, revision: Option<&Value>) -> Result<GoalRef, Refusal> {
    let id = match goal_id {
        Some(Value::String(text)) => text.as_str(),
        _ => "",
    };
    let number = match revision {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) if !js_trim(text).is_empty() => js_number_of_str(text),
        _ => f64::NAN,
    };
    if id.is_empty() || id != js_trim(id) || !is_safe_integer(number) || number < 1.0 {
        return Err(reject(messages::BAD_REF, codes::INVALID_UPDATE));
    }
    Ok(GoalRef {
        id: id.to_owned(),
        revision: number as u64,
    })
}

/// Whether an optional argument was really given.
///
/// DSH's filler rule (dsh-tool-goal:205-211): a strict schema makes some models fill every optional field, so an
/// empty string or 0 counts as omitted. A JSON `null` is treated the same way, because the registry does not
/// validate types and `String(null)` would otherwise become an objective.
fn given(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

/// A call with no session is refused: a goal is per session, never global.
fn no_session() -> ToolAnswer {
    ToolAnswer {
        output: String::new(),
        error: Some(ToolFailure {
            code: codes::NO_SESSION.to_owned(),
            message: "a goal belongs to a session, and this call has none".to_owned(),
        }),
        data: None,
    }
}

// --- JavaScript's coercions ---------------------------------------------------------------------------------------

/// The largest integer JavaScript calls safe: 2⁵³ − 1.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Number.isSafeInteger`.
fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER
}

/// `JSON.stringify` of a string.
fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string is plain data")
}

/// The characters `String.prototype.trim` removes: ECMAScript's WhiteSpace and LineTerminator.
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `String(number)`: an integer without a fraction, an exponent past 1e21 or below 1e-6 written `1e+21` / `1e-7`.
fn js_number_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    let magnitude = number.abs();
    if (1e-6..1e21).contains(&magnitude) {
        return number.to_string();
    }
    let exponential = format!("{number:e}");
    match exponential.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => exponential,
    }
}

/// `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::String(text) => text.clone(),
        Value::Number(number) => {
            if number.is_u64() || number.is_i64() {
                number.to_string()
            } else {
                js_number_string(number.as_f64().unwrap_or(f64::NAN))
            }
        }
        Value::Bool(flag) => flag.to_string(),
        // `Array.prototype.join` writes a null element as nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String(value ?? '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

/// `Number(text)` for a string: blank is 0; `Infinity`, hexadecimal, octal and binary literals as JavaScript reads
/// them; otherwise a decimal literal or `NaN`.
fn js_number_of_str(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = match text.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &text[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        return digits
            .chars()
            .try_fold(0.0f64, |total, digit| {
                digit
                    .to_digit(radix)
                    .map(|value| total * f64::from(radix) + f64::from(value))
            })
            .unwrap_or(f64::NAN);
    }
    if is_decimal_literal(text) {
        text.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// ECMAScript's StrDecimalLiteral without `Infinity`: `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`.
/// Rust's own float grammar also takes `inf` and `nan`, which JavaScript does not.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0;
    let digits = |at: &mut usize| {
        let start = *at;
        while *at < bytes.len() && bytes[*at].is_ascii_digit() {
            *at += 1;
        }
        *at - start
    };
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        at += 1;
    }
    let whole = digits(&mut at);
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        fraction = digits(&mut at);
    }
    if whole == 0 && fraction == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        if digits(&mut at) == 0 {
            return false;
        }
    }
    at == bytes.len()
}

/// `Number(value)`.
fn number_of(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number_of_str(text),
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::Array(_) => js_number_of_str(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    //! The goal tools' verbs and authority against DSH's `dsh-tool-goal` — the port of `test/goal-tool.test.ts`
    //! (R-developer-nine-2, -3 and -4) and of the tool tests in `test/goal.test.ts`.
    //!
    //! Every refusal is pinned by its code **and** DSH's sentence, written out here rather than read from
    //! [`messages`], because the sentence is what the model reads back. Authority is judged from the session's own
    //! log, so each test writes the messages a real turn would: a person's message has no `source`; the harness's
    //! messages (goal rounds, reminders, team mail, a child's notice) carry one; a turn ends with `turn/completed` or
    //! `turn/failed`.

    use std::sync::Arc;

    use serde_json::{Value, json};

    use super::*;
    use crate::test_support::{MemoryLog, fixture};

    const SESSION: &str = "s1";
    const HUMAN_REQUIRED: &str =
        "this goal operation requires a direct human turn on a top-level agent";
    const COMPLETION_AUTHORITY: &str =
        "complete and blocked require a direct human turn or the current goal round";
    const AUTHORITY: &str = "GOAL_TOOL_AUTHORITY_REQUIRED";
    const INVALID: &str = "GOAL_TOOL_INVALID_UPDATE";

    /// One session with a goal service and the tools over it; helpers write the messages a turn would.
    struct Fixture {
        log: Arc<MemoryLog>,
        goals: GoalService,
        settings: GoalToolSettings,
    }

    impl Fixture {
        fn new() -> Self {
            let (log, goals) = fixture(SESSION);
            Self {
                log,
                goals,
                settings: GoalToolSettings::default(),
            }
        }

        /// A session whose metadata names a delegation depth, as a subagent's does.
        fn delegated(depth: u64) -> Self {
            let fixture = Self::new();
            fixture.log.set_meta(
                SESSION,
                json!({"id": SESSION, "cwd": "/work", "parentSession": "session-parent", "origin": "subagent", "delegationDepth": depth, "turns": 0}),
            );
            fixture
        }

        /// The tools with `blockedAfterConsecutiveRounds` configured.
        fn configured(blocked_after: f64) -> Self {
            let config = GoalToolConfig {
                blocked_after_consecutive_rounds: Some(blocked_after),
            };
            Self {
                settings: resolve_goal_tool_config(&config).unwrap(),
                ..Self::new()
            }
        }

        fn call(&self, name: &str, args: Value) -> ToolAnswer {
            match name {
                CREATE_GOAL => run_create_goal(&self.goals, Some(SESSION), &args),
                GET_GOAL => run_get_goal(&self.goals, Some(SESSION)),
                UPDATE_GOAL => {
                    run_update_goal_with(&self.goals, Some(SESSION), &args, self.settings)
                }
                other => panic!("no tool {other}"),
            }
        }

        fn update(&self, args: Value) -> ToolAnswer {
            self.call(UPDATE_GOAL, args)
        }

        /// A person's message: no source at all.
        fn person(&self) {
            self.log.append_raw(
                SESSION,
                json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "go"}]}}),
            );
        }

        /// A message the harness wrote, with its source.
        fn sourced(&self, source: Value) {
            self.log.append_raw(
                SESSION,
                json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "go"}], "source": source}}),
            );
        }

        /// The end of the open turn.
        fn end_turn(&self, kind: &str) {
            self.log
                .append_raw(SESSION, json!({"type": kind, "rounds": 1}));
        }

        /// Goal rounds 1..=count for the goal's current revision, each in its own turn; round `count` is the open turn.
        fn rounds(&self, goal: &GoalView, count: u64) {
            for round in 1..=count {
                if round > 1 {
                    self.end_turn("turn/completed");
                }
                self.sourced(json!({"kind": "goal", "goalId": goal.goal.id, "revision": goal.goal.revision, "round": round}));
            }
        }

        /// A goal created through the domain, which needs no authority.
        fn create(&self, objective: &str) -> GoalView {
            self.goals
                .create(
                    SESSION,
                    CreateGoal {
                        objective: objective.to_owned(),
                        max_goal_rounds: None,
                    },
                )
                .unwrap()
        }

        fn current(&self) -> GoalView {
            self.goals.get(SESSION).unwrap().expect("a current goal")
        }

        fn changes(&self) -> usize {
            self.log
                .events(SESSION)
                .iter()
                .filter(|event| event["type"] == "goal/change")
                .count()
        }

        /// Assert a refusal by code and exact message, and that nothing was written.
        #[track_caller]
        fn refuses(&self, name: &str, args: Value, code: &str, message: &str) {
            let before = self.changes();
            let answer = self.call(name, args);
            assert_eq!(
                answer.error,
                Some(ToolFailure {
                    code: code.to_owned(),
                    message: message.to_owned()
                })
            );
            assert_eq!(answer.output, "");
            assert_eq!(self.changes(), before, "a refusal writes no goal change");
        }

        /// The call succeeded; its answer.
        #[track_caller]
        fn accepts(&self, name: &str, args: Value) -> ToolAnswer {
            let answer = self.call(name, args);
            assert_eq!(answer.error, None, "saw: {answer:?}");
            answer
        }
    }

    /// The goal's ref as the model passes it, with the call's other arguments.
    fn args(goal: &GoalView, extra: Value) -> Value {
        let mut call = json!({"goal_id": goal.goal.id, "revision": goal.goal.revision});
        if let (Some(target), Value::Object(extra)) = (call.as_object_mut(), extra) {
            target.extend(extra);
        }
        call
    }

    fn authority_of(answer: &ToolAnswer) -> Value {
        answer.data.as_ref().expect("data")["authority"].clone()
    }

    // --- A1: the schema ---------------------------------------------------------------------------------------

    #[test]
    fn update_goal_offers_exactly_dshs_five_verbs_with_dshs_descriptions_and_a_string_blocked_reason()
     {
        let specs = goal_tool_specs();
        let names: Vec<&str> = specs.iter().map(|spec| spec.name.as_str()).collect();
        assert_eq!(names, [CREATE_GOAL, GET_GOAL, UPDATE_GOAL]);
        assert_eq!(specs[0].description, CREATE_DESCRIPTION);
        assert_eq!(specs[0].parameters["required"], json!(["objective"]));
        assert_eq!(specs[1].parameters["properties"], json!({}));

        let update = &specs[2];
        let properties = &update.parameters["properties"];
        assert_eq!(
            properties["action"]["enum"],
            json!(["edit", "pause", "resume", "complete", "blocked"])
        );
        assert_eq!(
            UPDATE_ACTIONS,
            ["edit", "pause", "resume", "complete", "blocked"]
        );
        assert_eq!(update.description, "Update the current goal.");
        assert_eq!(
            properties["goal_id"]["description"],
            "Exact id returned by get_goal."
        );
        assert_eq!(
            properties["revision"]["description"],
            "Exact positive revision returned by get_goal."
        );
        assert_eq!(
            properties["action"]["description"],
            "edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count."
        );
        assert_eq!(
            properties["objective"]["description"],
            "Replacement objective; valid only with action edit."
        );
        assert_eq!(
            properties["max_goal_rounds"]["description"],
            "Replacement cap; valid only with action edit."
        );
        assert_eq!(properties["blocked_reason"]["type"], "string");
        assert_eq!(
            properties["blocked_reason"]["description"],
            "Required only with action blocked: the concrete condition that persisted across rounds and blocks progress."
        );
        assert_eq!(
            update.parameters["required"],
            json!(["goal_id", "revision", "action"])
        );
        // The TypeScript build's key order, which is the order the model reads them in.
        let keys: Vec<&str> = properties
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "goal_id",
                "revision",
                "action",
                "objective",
                "max_goal_rounds",
                "blocked_reason"
            ]
        );
        let action_keys: Vec<&str> = properties["action"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(action_keys, ["type", "enum", "description"]);
    }

    #[test]
    fn the_legacy_update_verb_still_edits_as_an_undocumented_alias_of_edit_with_edits_authority() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        f.accepts(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "update", "objective": "one, sharper", "max_goal_rounds": 9}),
            ),
        );
        assert_eq!(f.current().goal.objective, "one, sharper");
        assert_eq!(f.current().goal.max_goal_rounds, 9);
        assert_eq!(UpdateAction::parse("update"), Some(UpdateAction::Edit));

        let g = Fixture::new();
        let other = g.create("two");
        g.rounds(&other, 1);
        g.refuses(
            UPDATE_GOAL,
            args(&other, json!({"action": "update", "objective": "x"})),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
    }

    #[test]
    fn a_verb_outside_the_enum_is_refused_before_anything_runs() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        let unknown = "GOAL_TOOL_UNKNOWN_ACTION";
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "clear"})),
            unknown,
            "unknown goal action \"clear\"",
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "block", "blocked_reason": "x"})),
            unknown,
            "unknown goal action \"block\"",
        );
        // The alias table is an exact match, so no name a JavaScript prototype carries answers for a verb.
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "toString"})),
            unknown,
            "unknown goal action \"toString\"",
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "__proto__"})),
            unknown,
            "unknown goal action \"__proto__\"",
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({})),
            unknown,
            "unknown goal action \"\"",
        );
        // A verb that is not a string is no verb, and is named as JavaScript's String() writes it.
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": 5})),
            unknown,
            "unknown goal action \"5\"",
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": null})),
            unknown,
            "unknown goal action \"\"",
        );
    }

    #[test]
    fn a_malformed_ref_is_refused_with_dshs_sentence_before_authority() {
        let f = Fixture::new();
        let goal = f.create("one");
        let bad = "goal_id must be non-empty and revision must be a positive safe integer";
        // No human message at all: the ref is judged first, as in DSH.
        f.refuses(
            UPDATE_GOAL,
            json!({"goal_id": "", "revision": 1, "action": "complete"}),
            INVALID,
            bad,
        );
        f.refuses(
            UPDATE_GOAL,
            json!({"goal_id": format!(" {}", goal.goal.id), "revision": 1, "action": "edit", "objective": "x"}),
            INVALID,
            bad,
        );
        f.refuses(
            UPDATE_GOAL,
            json!({"goal_id": goal.goal.id, "revision": 0, "action": "pause"}),
            INVALID,
            bad,
        );
        f.refuses(
            UPDATE_GOAL,
            json!({"goal_id": goal.goal.id, "revision": 1.5, "action": "pause"}),
            INVALID,
            bad,
        );
        f.refuses(
            UPDATE_GOAL,
            json!({"goal_id": goal.goal.id, "action": "pause"}),
            INVALID,
            bad,
        );
        f.refuses(
            UPDATE_GOAL,
            json!({"goal_id": goal.goal.id, "revision": "  ", "action": "pause"}),
            INVALID,
            bad,
        );
        f.refuses(UPDATE_GOAL, json!({"goal_id": goal.goal.id, "revision": 9_007_199_254_740_992u64, "action": "pause"}), INVALID, bad);
        f.refuses(
            UPDATE_GOAL,
            json!({"goal_id": 7, "revision": 1, "action": "pause"}),
            INVALID,
            bad,
        );

        // A numeric string is read as JavaScript's Number() reads it.
        f.person();
        f.accepts(
            UPDATE_GOAL,
            json!({"goal_id": goal.goal.id, "revision": " 1 ", "action": "pause"}),
        );
        assert_eq!(f.current().goal.phase, GoalPhase::Paused);
    }

    // --- A1: filler and the per-action fields -----------------------------------------------------------------

    #[test]
    fn filler_an_empty_string_or_0_counts_as_omitted_in_update_goal() {
        let f = Fixture::new();
        f.person();
        let goal = f
            .goals
            .create(
                SESSION,
                CreateGoal {
                    objective: "one".to_owned(),
                    max_goal_rounds: Some(4.0),
                },
            )
            .unwrap();

        // Nothing but filler is an edit with no replacement: the domain's refusal, in DSH's words.
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "edit", "objective": "", "max_goal_rounds": 0, "blocked_reason": ""})),
            "GOAL_INVALID_EDIT",
            "goal edit requires objective and/or maxGoalRounds",
        );
        // A null is filler too.
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "edit", "objective": null, "max_goal_rounds": null, "blocked_reason": null})),
            "GOAL_INVALID_EDIT",
            "goal edit requires objective and/or maxGoalRounds",
        );
        // A real objective beside a zero cap changes only the objective.
        f.accepts(
            UPDATE_GOAL,
            args(&goal, json!({"action": "edit", "objective": "one, sharper", "max_goal_rounds": 0, "blocked_reason": ""})),
        );
        assert_eq!(f.current().goal.objective, "one, sharper");
        assert_eq!(f.current().goal.max_goal_rounds, 4);

        f.accepts(
            UPDATE_GOAL,
            args(&f.current(), json!({"action": "pause", "objective": "", "max_goal_rounds": 0, "blocked_reason": ""})),
        );
        assert_eq!(f.current().goal.phase, GoalPhase::Paused);

        f.accepts(
            UPDATE_GOAL,
            args(&f.current(), json!({"action": "complete", "objective": "", "max_goal_rounds": 0, "blocked_reason": ""})),
        );
        assert_eq!(f.current().goal.phase, GoalPhase::Complete);
    }

    #[test]
    fn filler_blocked_with_an_empty_objective_and_a_zero_cap_is_still_a_block() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        f.accepts(
            UPDATE_GOAL,
            args(&goal, json!({"action": "blocked", "objective": "", "max_goal_rounds": 0, "blocked_reason": "no key"})),
        );
        assert_eq!(f.current().goal.phase, GoalPhase::Blocked);
    }

    #[test]
    fn each_verb_refuses_the_fields_that_belong_to_another_with_dshs_sentences() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        let reason_only = "blocked_reason is valid only with action blocked";
        let edit_only = "objective and max_goal_rounds are valid only with action edit";
        let pause_resume = "objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked";

        f.refuses(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "edit", "objective": "x", "blocked_reason": "y"}),
            ),
            INVALID,
            reason_only,
        );
        f.refuses(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "edit", "objective": "x", "blocked_reason": "   "}),
            ),
            INVALID,
            reason_only,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "pause", "objective": "x"})),
            INVALID,
            pause_resume,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "pause", "blocked_reason": "y"})),
            INVALID,
            pause_resume,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "resume", "max_goal_rounds": 5})),
            INVALID,
            pause_resume,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "complete", "objective": "x"})),
            INVALID,
            edit_only,
        );
        f.refuses(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "max_goal_rounds": 5, "blocked_reason": "y"}),
            ),
            INVALID,
            edit_only,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "complete", "blocked_reason": "y"})),
            INVALID,
            reason_only,
        );
    }

    #[test]
    fn blocked_needs_a_reason_as_a_non_blank_string() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        let required = "blocked_reason is required with action blocked";
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "blocked"})),
            INVALID,
            required,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "blocked", "blocked_reason": ""})),
            INVALID,
            required,
        );
        f.refuses(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "  \n "}),
            ),
            INVALID,
            required,
        );
        // JavaScript's trim also removes a byte-order mark.
        f.refuses(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "\u{FEFF}"}),
            ),
            INVALID,
            required,
        );
        // The old object shape is no longer the schema: it is refused rather than half-read.
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "blocked", "blocked_reason": {"code": "missing-input", "message": "needs a key"}})),
            INVALID,
            required,
        );
    }

    #[test]
    fn a_models_blocked_reason_is_stored_as_model_reported_with_the_trimmed_message() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        let answer = f.accepts(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "  the API key is missing  "}),
            ),
        );
        let expected = GoalBlockReason {
            code: "model-reported".to_owned(),
            message: "the API key is missing".to_owned(),
        };
        assert_eq!(f.current().goal.blocked_reason, Some(expected));
        assert_eq!(f.current().goal.phase, GoalPhase::Blocked);
        let view: Value = serde_json::from_str(&answer.output).unwrap();
        assert_eq!(
            view["blockedReason"],
            json!({"code": "model-reported", "message": "the API key is missing"})
        );
    }

    // --- A2: the block threshold ------------------------------------------------------------------------------

    #[test]
    fn a_goal_round_may_not_block_before_round_n_default_3_n_minus_1_is_refused_n_is_accepted() {
        let early = Fixture::new();
        let goal = early.create("one");
        early.rounds(&goal, 2);
        assert_eq!(early.current().rounds_started, 2);
        early.refuses(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
            "GOAL_TOOL_BLOCK_THRESHOLD",
            "blocked requires at least 3 consecutive goal rounds; current round is 2",
        );
        assert_eq!(early.current().goal.phase, GoalPhase::Active);

        let on_time = Fixture::new();
        let other = on_time.create("two");
        on_time.rounds(&other, 3);
        let answer = on_time.accepts(
            UPDATE_GOAL,
            args(
                &other,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
        );
        assert_eq!(on_time.current().goal.phase, GoalPhase::Blocked);
        assert_eq!(authority_of(&answer), "goal-round");
    }

    #[test]
    fn the_threshold_binds_only_goal_rounds_a_person_may_block_at_round_0_and_a_steered_persons_message_counts()
     {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        assert_eq!(f.current().rounds_started, 0);
        let answer = f.accepts(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
        );
        assert_eq!(authority_of(&answer), "direct-human");

        // A person steering into goal round 1 makes the turn a direct human turn, so the threshold does not apply.
        let g = Fixture::new();
        let other = g.create("two");
        g.rounds(&other, 1);
        g.person();
        let steered = g.accepts(
            UPDATE_GOAL,
            args(
                &other,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
        );
        assert_eq!(authority_of(&steered), "direct-human");
        assert!(
            !steered.output.contains("<goal_blocked>"),
            "a direct human turn is not told to end its run"
        );
    }

    #[test]
    fn blocked_after_consecutive_rounds_is_configurable_and_validated_as_a_positive_safe_integer() {
        let five = Fixture::configured(5.0);
        let goal = five.create("one");
        five.rounds(&goal, 4);
        five.refuses(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
            "GOAL_TOOL_BLOCK_THRESHOLD",
            "blocked requires at least 5 consecutive goal rounds; current round is 4",
        );
        five.end_turn("turn/completed");
        five.sourced(json!({"kind": "goal", "goalId": goal.goal.id, "revision": goal.goal.revision, "round": 5}));
        five.accepts(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
        );

        let one = Fixture::configured(1.0);
        let first = one.create("one");
        one.rounds(&first, 1);
        one.accepts(
            UPDATE_GOAL,
            args(
                &first,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
        );

        for bad in [0.0, -1.0, 1.5, f64::NAN, 9_007_199_254_740_992.0] {
            let error = resolve_goal_tool_config(&GoalToolConfig {
                blocked_after_consecutive_rounds: Some(bad),
            })
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "blockedAfterConsecutiveRounds must be a positive safe integer"
            );
        }
        let read = |config: Value| {
            resolve_goal_tool_config(&serde_json::from_value::<GoalToolConfig>(config).unwrap())
        };
        assert_eq!(
            read(json!({})),
            Ok(GoalToolSettings {
                blocked_after_consecutive_rounds: 3
            })
        );
        assert_eq!(read(json!({})), Ok(GoalToolSettings::default()));
        assert_eq!(
            read(json!({"blockedAfterConsecutiveRounds": 5})),
            Ok(GoalToolSettings {
                blocked_after_consecutive_rounds: 5
            })
        );
        assert!(read(json!({"blockedAfterConsecutiveRounds": 0})).is_err());
    }

    // --- A3: authority ----------------------------------------------------------------------------------------

    #[test]
    fn a_direct_human_turn_may_create_edit_pause_complete_and_resume_a_blocked_goal_but_not_a_paused_one()
     {
        let f = Fixture::new();
        f.person();
        f.accepts(
            CREATE_GOAL,
            json!({"objective": "one", "max_goal_rounds": 5}),
        );
        let goal = f.current();
        f.accepts(
            UPDATE_GOAL,
            args(
                &goal,
                json!({"action": "edit", "objective": "one, sharper"}),
            ),
        );
        f.accepts(UPDATE_GOAL, args(&f.current(), json!({"action": "pause"})));
        // Even inside a person's own turn: the pause is the person's decision, and only the person undoes it.
        f.refuses(
            UPDATE_GOAL,
            args(&f.current(), json!({"action": "resume"})),
            "GOAL_TOOL_RESUME_PAUSED",
            "the model cannot resume a paused goal; the user must resume it",
        );
        f.accepts(
            UPDATE_GOAL,
            args(&f.current(), json!({"action": "complete"})),
        );

        let g = Fixture::new();
        g.person();
        let other = g.create("two");
        let blocked = g
            .goals
            .block(
                SESSION,
                &other.goal.goal_ref(),
                &json!({"code": "missing-input", "message": "needs a key"}),
            )
            .unwrap();
        g.accepts(UPDATE_GOAL, args(&blocked, json!({"action": "resume"})));
        assert_eq!(g.current().goal.phase, GoalPhase::Active);
    }

    #[test]
    fn dshs_explicit_kind_user_source_is_a_person_too() {
        let f = Fixture::new();
        f.sourced(json!({"kind": "user"}));
        f.accepts(CREATE_GOAL, json!({"objective": "one"}));
    }

    #[test]
    fn a_goal_round_may_complete_or_block_its_goal_and_nothing_else() {
        let f = Fixture::new();
        let goal = f.create("one");
        f.rounds(&goal, 1);
        f.refuses(
            CREATE_GOAL,
            json!({"objective": "two"}),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "edit", "objective": "x"})),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "pause"})),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
        f.goals.disarm(SESSION).unwrap();
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "resume"})),
            AUTHORITY,
            HUMAN_REQUIRED,
        );

        let completed = f.accepts(UPDATE_GOAL, args(&goal, json!({"action": "complete"})));
        assert_eq!(f.current().goal.phase, GoalPhase::Complete);
        assert_eq!(authority_of(&completed), "goal-round");
    }

    #[test]
    fn the_human_check_comes_before_the_paused_check_a_goal_round_resuming_a_paused_goal_is_an_authority_refusal()
     {
        let f = Fixture::new();
        let goal = f.create("one");
        f.rounds(&goal, 1);
        let paused = f.goals.pause(SESSION, &goal.goal.goal_ref()).unwrap();
        f.refuses(
            UPDATE_GOAL,
            args(&paused, json!({"action": "resume"})),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
    }

    #[test]
    fn only_the_current_round_has_authority_a_revision_edited_mid_round_or_another_goals_round_has_none()
     {
        let f = Fixture::new();
        let goal = f.create("one");
        f.rounds(&goal, 1);
        let edited = f
            .goals
            .edit(
                SESSION,
                &goal.goal.goal_ref(),
                EditGoal {
                    objective: Some("one, sharper".to_owned()),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        f.refuses(
            UPDATE_GOAL,
            args(&edited, json!({"action": "complete"})),
            AUTHORITY,
            COMPLETION_AUTHORITY,
        );

        let g = Fixture::new();
        let first = g.create("first");
        g.rounds(&first, 1);
        g.goals.complete(SESSION, &first.goal.goal_ref()).unwrap();
        let second = g.create("second");
        // The open turn is the first goal's round; the second goal has had none.
        g.refuses(
            UPDATE_GOAL,
            args(&second, json!({"action": "complete"})),
            AUTHORITY,
            COMPLETION_AUTHORITY,
        );
    }

    #[test]
    fn a_turn_the_harness_started_for_a_reminder_team_mail_or_a_childs_notice_has_no_authority() {
        let sources = [
            json!({"kind": "schedule", "scheduleId": "sched-1"}),
            json!({"kind": "team-message", "teamId": "session-lead", "messageId": "m-1", "senderId": "a", "senderName": "A"}),
            json!({"kind": "team-prompt", "teamId": "session-lead", "memberId": "session-member"}),
            json!({"kind": "subagent-settled", "form": "notice", "summary": "done", "senderSessionId": "session-child"}),
            Value::Null,
        ];
        for source in sources {
            let f = Fixture::new();
            let goal = f.create("one");
            f.sourced(source);
            f.refuses(
                CREATE_GOAL,
                json!({"objective": "two"}),
                AUTHORITY,
                HUMAN_REQUIRED,
            );
            f.refuses(
                UPDATE_GOAL,
                args(&goal, json!({"action": "edit", "objective": "x"})),
                AUTHORITY,
                HUMAN_REQUIRED,
            );
            f.refuses(
                UPDATE_GOAL,
                args(&goal, json!({"action": "pause"})),
                AUTHORITY,
                HUMAN_REQUIRED,
            );
            f.refuses(
                UPDATE_GOAL,
                args(&goal, json!({"action": "complete"})),
                AUTHORITY,
                COMPLETION_AUTHORITY,
            );
            f.refuses(
                UPDATE_GOAL,
                args(&goal, json!({"action": "blocked", "blocked_reason": "x"})),
                AUTHORITY,
                COMPLETION_AUTHORITY,
            );
        }
    }

    #[test]
    fn a_persons_message_in_an_earlier_turn_grants_nothing_to_the_open_one() {
        for end in ["turn/completed", "turn/failed"] {
            let f = Fixture::new();
            let goal = f.create("one");
            f.person();
            f.end_turn(end);
            f.sourced(json!({"kind": "schedule"}));
            f.refuses(
                CREATE_GOAL,
                json!({"objective": "two"}),
                AUTHORITY,
                HUMAN_REQUIRED,
            );
            f.refuses(
                UPDATE_GOAL,
                args(&goal, json!({"action": "complete"})),
                AUTHORITY,
                COMPLETION_AUTHORITY,
            );
        }
        // And a goal round after a person's turn has the goal round's authority only.
        let g = Fixture::new();
        g.person();
        g.end_turn("turn/completed");
        let goal = g.create("one");
        g.rounds(&goal, 1);
        g.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "edit", "objective": "x"})),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
        let completed = g.accepts(UPDATE_GOAL, args(&goal, json!({"action": "complete"})));
        assert_eq!(authority_of(&completed), "goal-round");
    }

    #[test]
    fn the_open_turn_is_everything_after_the_last_turn_completed_or_turn_failed() {
        let event = |seq: u64, kind: &str| json!({"seq": seq, "at": "", "type": kind});
        let seqs = |events: &[Value]| -> Vec<u64> {
            open_turn_events(events)
                .iter()
                .map(|event| event["seq"].as_u64().unwrap())
                .collect()
        };
        assert_eq!(
            seqs(&[
                event(0, "message"),
                event(1, "turn/completed"),
                event(2, "message"),
                event(3, "goal/change")
            ]),
            [2, 3]
        );
        assert_eq!(
            seqs(&[
                event(0, "turn/completed"),
                event(1, "message"),
                event(2, "turn/failed"),
                event(3, "message")
            ]),
            [3]
        );
        assert_eq!(
            seqs(&[event(0, "session/created"), event(1, "message")]),
            [0, 1],
            "no turn has ended yet"
        );
        assert!(
            open_turn_events(&[event(0, "message"), event(1, "turn/completed")]).is_empty(),
            "between turns nothing is open"
        );
    }

    #[test]
    fn a_delegated_session_is_never_a_direct_human_turn_though_its_own_goal_round_still_counts() {
        let f = Fixture::delegated(1);
        f.person();
        let goal = f.create("one");
        f.refuses(
            CREATE_GOAL,
            json!({"objective": "two"}),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "pause"})),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
        f.refuses(
            UPDATE_GOAL,
            args(&goal, json!({"action": "complete"})),
            AUTHORITY,
            COMPLETION_AUTHORITY,
        );

        // DSH checks the root only for human input; the exact goal round is authority on any agent.
        f.end_turn("turn/completed");
        f.rounds(&goal, 1);
        let completed = f.accepts(UPDATE_GOAL, args(&goal, json!({"action": "complete"})));
        assert_eq!(authority_of(&completed), "goal-round");

        let top = Fixture::delegated(0);
        top.person();
        top.accepts(CREATE_GOAL, json!({"objective": "one"}));

        // The record's own rule: absent or 0 is top level, anything else — a null included — is not.
        assert!(is_top_level(None));
        assert!(is_top_level(Some(&json!({"id": "s"}))));
        assert!(is_top_level(Some(&json!({"delegationDepth": 0}))));
        assert!(!is_top_level(Some(&json!({"delegationDepth": 1}))));
        assert!(!is_top_level(Some(&json!({"delegationDepth": null}))));
    }

    #[test]
    fn a_fresh_session_with_no_message_in_its_open_turn_has_no_authority() {
        let f = Fixture::new();
        f.refuses(
            CREATE_GOAL,
            json!({"objective": "one"}),
            AUTHORITY,
            HUMAN_REQUIRED,
        );
    }

    #[test]
    fn get_goal_needs_no_authority_and_create_goal_keeps_refusing_a_zero_cap() {
        let f = Fixture::delegated(2);
        let goal = f.create("one");
        f.sourced(json!({"kind": "schedule"}));
        let read: Value = serde_json::from_str(&f.call(GET_GOAL, json!({})).output).unwrap();
        assert_eq!(read["id"], json!(goal.goal.id));

        let g = Fixture::new();
        g.person();
        g.refuses(
            CREATE_GOAL,
            json!({"objective": "one", "max_goal_rounds": 0}),
            "GOAL_INVALID_MAX_ROUNDS",
            "maxGoalRounds must be a positive safe integer",
        );
    }

    // --- A4: the end of the run -------------------------------------------------------------------------------

    #[test]
    fn only_a_goal_round_is_told_to_end_its_run_with_dshs_closing_text() {
        let human = Fixture::new();
        human.person();
        let goal = human.create("ship it");
        let done = human.accepts(UPDATE_GOAL, args(&goal, json!({"action": "complete"})));
        let reparsed: Value = serde_json::from_str(&done.output).unwrap();
        assert_eq!(
            done.output,
            serde_json::to_string(&reparsed).unwrap(),
            "a person's complete answers the goal and nothing else"
        );
        assert!(!done.output.contains("<goal_complete>"));
        assert_eq!(authority_of(&done), "direct-human");

        let round = Fixture::new();
        let other = round.create("ship it");
        round.rounds(&other, 1);
        let completed = round.accepts(UPDATE_GOAL, args(&other, json!({"action": "complete"})));
        let (json_text, closing) = completed
            .output
            .split_once("\n\n<goal_complete>")
            .expect("the closing block follows the goal");
        assert_eq!(
            serde_json::from_str::<Value>(json_text).unwrap()["phase"],
            "complete"
        );
        assert!(!closing.is_empty());
        assert!(
            completed
                .output
                .ends_with(&format!("\n\n{}", end_of_run("ship it", None)))
        );
        assert!(end_of_run("ship it", None).starts_with(
            "<goal_complete>\nObjective: \"ship it\"\nThe goal is marked complete and this autonomous run is ending."
        ));
        assert!(end_of_run("ship it", None).ends_with(
            "Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_complete>"
        ));

        let blocked = Fixture::new();
        let third = blocked.create("ship it");
        blocked.rounds(&third, 3);
        let answer = blocked.accepts(
            UPDATE_GOAL,
            args(
                &third,
                json!({"action": "blocked", "blocked_reason": " no key "}),
            ),
        );
        assert!(
            answer
                .output
                .ends_with(&format!("\n\n{}", end_of_run("ship it", Some("no key"))))
        );
        assert!(end_of_run("ship it", Some("no key")).starts_with(
            "<goal_blocked>\nObjective: \"ship it\"\nBlocked: \"no key\"\nThe goal is marked blocked and this autonomous run is ending."
        ));
        assert!(end_of_run("ship it", Some("no key")).ends_with("</goal_blocked>"));
    }

    #[test]
    fn the_closing_text_is_dshs_verbatim_and_quotes_as_json_stringify_does() {
        assert_eq!(
            end_of_run("ship \"it\"\n", None),
            "<goal_complete>\nObjective: \"ship \\\"it\\\"\\n\"\nThe goal is marked complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Note anything the user should review or do next. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_complete>"
        );
        assert_eq!(
            end_of_run("one", Some("no \"key\"")),
            "<goal_blocked>\nObjective: \"one\"\nBlocked: \"no \\\"key\\\"\"\nThe goal is marked blocked and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue. Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_blocked>"
        );
    }

    #[test]
    fn the_tool_goal_guidance_is_dshs_sentence_with_the_configured_threshold() {
        assert_eq!(
            goal_tool_guidance(3),
            "create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked."
        );
        assert!(goal_tool_guidance(5).contains("for at least 5 consecutive goal rounds"));
        assert_eq!(
            goal_tool_guidance(GoalToolSettings::default().blocked_after_consecutive_rounds),
            goal_tool_guidance(3)
        );
    }

    // --- The tools' plumbing ----------------------------------------------------------------------------------

    #[test]
    fn a_call_without_a_session_is_refused_by_all_three() {
        let (_log, goals) = fixture(SESSION);
        for answer in [
            run_create_goal(&goals, None, &json!({"objective": "x"})),
            run_get_goal(&goals, None),
            run_update_goal(&goals, None, &json!({})),
        ] {
            assert_eq!(
                answer.error,
                Some(ToolFailure {
                    code: "GOAL_TOOL_NO_SESSION".to_owned(),
                    message: "a goal belongs to a session, and this call has none".to_owned()
                })
            );
        }
    }

    #[test]
    fn the_create_tool_creates_and_the_read_tool_reads_it_back() {
        let f = Fixture::new();
        f.person();
        let created = f.accepts(
            CREATE_GOAL,
            json!({"objective": "finish the goal feature", "max_goal_rounds": 6}),
        );
        let view: Value = serde_json::from_str(&created.output).unwrap();
        assert_eq!(view["phase"], "active");
        assert_eq!(view["maxGoalRounds"], 6);
        assert_eq!(view["activation"], "armed");
        assert_eq!(view["roundsStarted"], 0);
        assert_eq!(created.data.unwrap()["goal"]["id"], view["id"]);
        let keys: Vec<&str> = view
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "id",
                "revision",
                "objective",
                "phase",
                "activation",
                "roundsStarted",
                "maxGoalRounds",
                "createdAt",
                "updatedAt"
            ]
        );

        let read: Value = serde_json::from_str(&f.call(GET_GOAL, json!({})).output).unwrap();
        assert_eq!(read["id"], view["id"]);
    }

    #[test]
    fn a_session_without_a_goal_reads_as_null() {
        let f = Fixture::new();
        let answer = f.call(GET_GOAL, json!({}));
        assert_eq!(answer.output, "no goal is current in this session");
        assert_eq!(answer.data.unwrap()["goal"], Value::Null);
    }

    #[test]
    fn the_update_tool_re_arms_an_active_but_disarmed_goal_when_a_person_asks() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        f.goals.disarm(SESSION).unwrap();
        let resumed = f.accepts(UPDATE_GOAL, args(&goal, json!({"action": "resume"})));
        let resumed: Value = serde_json::from_str(&resumed.output).unwrap();
        assert_eq!(resumed["phase"], "active");
        assert_eq!(resumed["activation"], "armed");
        assert_eq!(resumed["revision"], 2);
    }

    #[test]
    fn a_stale_revision_keeps_its_service_code() {
        let f = Fixture::new();
        f.person();
        let goal = f.create("one");
        let answer = f.update(json!({"goal_id": goal.goal.id, "revision": 99, "action": "pause"}));
        assert_eq!(answer.error.unwrap().code, "GOAL_STALE_REVISION");
    }

    #[test]
    fn the_default_update_tool_blocks_from_round_3() {
        let f = Fixture::new();
        let goal = f.create("one");
        f.rounds(&goal, 2);
        let answer = run_update_goal(
            &f.goals,
            Some(SESSION),
            &args(
                &goal,
                json!({"action": "blocked", "blocked_reason": "no key"}),
            ),
        );
        assert_eq!(answer.error.unwrap().code, "GOAL_TOOL_BLOCK_THRESHOLD");
    }

    #[test]
    fn javascript_coercions_are_javascripts() {
        assert_eq!(js_number_of_str(""), 0.0);
        assert_eq!(js_number_of_str(" 3 "), 3.0);
        assert_eq!(js_number_of_str("0x10"), 16.0);
        assert_eq!(js_number_of_str("0b11"), 3.0);
        assert_eq!(js_number_of_str("1e2"), 100.0);
        assert_eq!(js_number_of_str("1."), 1.0);
        assert_eq!(js_number_of_str(".5"), 0.5);
        assert_eq!(js_number_of_str("+5"), 5.0);
        assert_eq!(js_number_of_str("Infinity"), f64::INFINITY);
        for not_a_number in ["inf", "nan", "infinity", "--5", "1_0", "0x", "1e", "."] {
            assert!(js_number_of_str(not_a_number).is_nan(), "{not_a_number}");
        }
        assert_eq!(js_string(&json!(5.0)), "5");
        assert_eq!(js_string(&json!(0.5)), "0.5");
        assert_eq!(js_string(&json!(1e21)), "1e+21");
        assert_eq!(js_string(&json!(1.5e-7)), "1.5e-7");
        assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_trim("\u{FEFF}\u{3000} x \n"), "x");
        assert_eq!(
            js_trim("\u{0085}x"),
            "\u{0085}x",
            "NEL is not JavaScript whitespace"
        );
        assert!(given(Some(&json!("0"))));
        assert!(given(Some(&json!(false))));
        assert!(!given(Some(&json!(0.0))));
        assert!(!given(Some(&json!(""))));
        assert!(!given(Some(&Value::Null)));
        assert!(!given(None));
    }
}
