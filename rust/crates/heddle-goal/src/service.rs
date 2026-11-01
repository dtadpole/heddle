//! The event-sourced state machine: the `goal/change` shape, the strict fold, and the service.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::log::{Clock, LogError, SessionLog, SystemClock};

/// Version of the `goal/change` payload shape. A log written by a later version fails loudly.
pub const GOAL_CHANGE_VERSION: u64 = 1;

/// The event type every mutation appends.
pub const GOAL_CHANGE_EVENT: &str = "goal/change";

/// The round cap `create` uses when none is named: 100, the owner's number (lowered from DSH's 256 on
/// 2026-10-17 — a goal that has not converged in a hundred rounds blocks loudly instead).
pub const DEFAULT_MAX_GOAL_ROUNDS: u64 = 100;

/// The longest objective, in UTF-16 code units — JavaScript's `length`, which is what the TypeScript build counts.
pub const MAX_OBJECTIVE_LENGTH: usize = 8000;

/// The longest block-reason message, in UTF-16 code units.
pub const MAX_BLOCK_MESSAGE_LENGTH: usize = 2000;

/// Stable identity of one goal across its revisions: `goal-<uuid>`.
pub type GoalId = String;

/// Compare-and-set identity of one exact goal revision. Serialized `{id, revision}`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GoalRef {
    /// The goal.
    pub id: GoalId,
    /// Positive; every durable mutation increments it by one.
    pub revision: u64,
}

/// The durable lifecycle phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalPhase {
    /// Being pursued.
    Active,
    /// Stopped by a person; only a person resumes it.
    Paused,
    /// Stopped with a reason (`round-limit` when the cap was reached).
    Blocked,
    /// Done; not mutated again — cleared, then replaced.
    Complete,
}

impl GoalPhase {
    /// The serialized name.
    pub const fn as_str(self) -> &'static str {
        match self {
            GoalPhase::Active => "active",
            GoalPhase::Paused => "paused",
            GoalPhase::Blocked => "blocked",
            GoalPhase::Complete => "complete",
        }
    }
}

/// Whether this live process may keep continuing an active goal on its own. Never written to the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalActivation {
    /// The driver may run rounds.
    Armed,
    /// It may not.
    Disarmed,
}

impl GoalActivation {
    /// The serialized name.
    pub const fn as_str(self) -> &'static str {
        match self {
            GoalActivation::Armed => "armed",
            GoalActivation::Disarmed => "disarmed",
        }
    }
}

/// Why a goal is blocked: a lower-kebab-case code and a sentence. Serialized `{code, message}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalBlockReason {
    /// Stable lower-kebab-case classification, e.g. `round-limit`.
    pub code: String,
    /// 1 to 2000 characters a person and a model can read.
    pub message: String,
}

/// The full durable state every non-clear mutation writes, in the TypeScript key order
/// `{id, revision, objective, phase, maxGoalRounds, blockedReason?}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSnapshot {
    /// The goal's identity.
    pub id: GoalId,
    /// Its revision.
    pub revision: u64,
    /// What completes it; trimmed, non-empty, at most [`MAX_OBJECTIVE_LENGTH`].
    pub objective: String,
    /// Its phase.
    pub phase: GoalPhase,
    /// The total admitted-round cap.
    pub max_goal_rounds: u64,
    /// Present exactly while `phase` is `blocked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<GoalBlockReason>,
}

impl GoalSnapshot {
    /// This revision's compare-and-set identity.
    pub fn goal_ref(&self) -> GoalRef {
        GoalRef {
            id: self.id.clone(),
            revision: self.revision,
        }
    }
}

/// What a reader (the route, the command line, the driver) sees: the snapshot plus what the log and the
/// process add. Serialized as the snapshot's keys followed by `roundsStarted, createdAt, updatedAt, activation`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalView {
    /// The durable snapshot.
    #[serde(flatten)]
    pub goal: GoalSnapshot,
    /// Admitted continuation rounds of this goal — derived from the log, not a stored counter.
    pub rounds_started: u64,
    /// When the goal was created.
    pub created_at: String,
    /// When it last changed.
    pub updated_at: String,
    /// Process-local continuation eligibility.
    pub activation: GoalActivation,
}

/// The stable refusals; a caller switches on the code, not on the sentence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GoalErrorCode {
    /// `GOAL_NOT_FOUND` — the route answers 404.
    NotFound,
    /// `GOAL_ALREADY_EXISTS`.
    AlreadyExists,
    /// `GOAL_STALE_REVISION` — the route answers 409.
    StaleRevision,
    /// `GOAL_INVALID_OBJECTIVE`.
    InvalidObjective,
    /// `GOAL_INVALID_MAX_ROUNDS`.
    InvalidMaxRounds,
    /// `GOAL_INVALID_BLOCK_REASON`.
    InvalidBlockReason,
    /// `GOAL_INVALID_EDIT`.
    InvalidEdit,
    /// `GOAL_INVALID_TRANSITION`.
    InvalidTransition,
    /// `GOAL_INVALID_LOG` — the log does not fold.
    InvalidLog,
}

impl GoalErrorCode {
    /// The stable code.
    pub const fn as_str(self) -> &'static str {
        match self {
            GoalErrorCode::NotFound => "GOAL_NOT_FOUND",
            GoalErrorCode::AlreadyExists => "GOAL_ALREADY_EXISTS",
            GoalErrorCode::StaleRevision => "GOAL_STALE_REVISION",
            GoalErrorCode::InvalidObjective => "GOAL_INVALID_OBJECTIVE",
            GoalErrorCode::InvalidMaxRounds => "GOAL_INVALID_MAX_ROUNDS",
            GoalErrorCode::InvalidBlockReason => "GOAL_INVALID_BLOCK_REASON",
            GoalErrorCode::InvalidEdit => "GOAL_INVALID_EDIT",
            GoalErrorCode::InvalidTransition => "GOAL_INVALID_TRANSITION",
            GoalErrorCode::InvalidLog => "GOAL_INVALID_LOG",
        }
    }
}

/// A refused or failed goal operation.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum GoalError {
    /// Refused, with the stable code and the TypeScript build's sentence.
    #[error("{message}")]
    Refused {
        /// Which refusal.
        code: GoalErrorCode,
        /// The sentence.
        message: String,
    },
    /// The session log failed; reported under `GOAL_TOOL_ERROR` by the tools and with an empty code by the route,
    /// as the TypeScript build reports any error that is not a `GoalError`.
    #[error("{0}")]
    Log(#[from] LogError),
}

impl GoalError {
    /// The stable code, for a refusal.
    pub fn code(&self) -> Option<GoalErrorCode> {
        match self {
            GoalError::Refused { code, .. } => Some(*code),
            GoalError::Log(_) => None,
        }
    }
}

/// The operations a snapshot change records; a clear has its own tombstone shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalOperation {
    /// A new goal at revision 1.
    Create,
    /// The objective and/or the cap changed — the only operation that may change them.
    Edit,
    /// `active` → `paused`.
    Pause,
    /// `active` (disarmed) | `paused` | `blocked` → `active`, armed.
    Resume,
    /// `active` | `paused` | `blocked` → `complete`.
    Complete,
    /// `active` → `blocked`, with a reason.
    Block,
}

/// One decoded `goal/change`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoalChange {
    /// A full snapshot change.
    Snapshot {
        /// What was done.
        operation: GoalOperation,
        /// The resulting snapshot.
        goal: GoalSnapshot,
        /// The rounds counted when it was written.
        rounds_started: u64,
        /// The goal's creation time.
        created_at: String,
        /// This change's time.
        updated_at: String,
    },
    /// A clear tombstone: the goal is gone, the history stays.
    Clear {
        /// The cleared goal at the revision one past its last snapshot.
        cleared: GoalRef,
        /// When.
        cleared_at: String,
    },
}

/// The durable projection of a session's goal, folded from its log.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FoldedGoal {
    /// The current goal; `None` before the first create and after a clear.
    pub goal: Option<GoalSnapshot>,
    /// Admitted continuation rounds of the current goal: the larger of the last change's count and the
    /// attributed goal messages in the log.
    pub rounds_started: u64,
    /// The current goal's creation time.
    pub created_at: Option<String>,
    /// Its last change's time.
    pub updated_at: Option<String>,
    /// The latest mutation's identity, a clear tombstone included.
    pub last_ref: Option<GoalRef>,
}

/// One refusal with the code the caller named.
fn refused(code: GoalErrorCode, message: impl Into<String>) -> GoalError {
    GoalError::Refused {
        code,
        message: message.into(),
    }
}

/// A log that does not decode, which is the default code.
fn invalid_log(message: impl Into<String>) -> GoalError {
    refused(GoalErrorCode::InvalidLog, message)
}

/// The largest integer JavaScript calls safe: 2⁵³ − 1.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// A JSON value the way `JSON.stringify` writes it into a message.
fn json_text(value: &Value) -> String {
    match value {
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| text.clone()),
        other => serde_json::to_string(other).unwrap_or_else(|_| "undefined".to_owned()),
    }
}

/// `String(value)` for a version in the TypeScript message.
fn version_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Null => "null".to_owned(),
        other => json_text(other),
    }
}

/// A JSON number as an integer, the way `Number.isSafeInteger` sees it.
fn integer_of(value: &Value) -> Option<u64> {
    let Value::Number(number) = value else {
        return None;
    };
    if let Some(value) = number.as_u64() {
        return Some(value);
    }
    let float = number.as_f64()?;
    (float.is_finite() && float.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER as f64).contains(&float))
        .then_some(float as u64)
}

/// A positive safe integer in a log.
fn positive_integer(value: Option<&Value>, name: &str) -> Result<u64, GoalError> {
    match value.and_then(integer_of) {
        Some(number) if (1..=MAX_SAFE_INTEGER).contains(&number) => Ok(number),
        _ => Err(invalid_log(format!("{name} must be a positive integer"))),
    }
}

/// A non-negative safe integer in a log.
fn non_negative_integer(value: Option<&Value>, name: &str) -> Result<u64, GoalError> {
    match value.and_then(integer_of) {
        Some(number) if number <= MAX_SAFE_INTEGER => Ok(number),
        _ => Err(invalid_log(format!(
            "{name} must be a non-negative integer"
        ))),
    }
}

/// A non-empty string a log carries, kept untrimmed as the snapshot carries it.
fn non_empty_string(value: Option<&Value>, name: &str) -> Result<String, GoalError> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.clone()),
        _ => Err(invalid_log(format!("{name} must be a non-empty string"))),
    }
}

/// The cap, validated for a `create` or `edit` request (`GOAL_INVALID_MAX_ROUNDS`).
fn valid_max_goal_rounds(number: f64) -> Result<u64, GoalError> {
    if number.is_finite()
        && number.fract() == 0.0
        && (1.0..=MAX_SAFE_INTEGER as f64).contains(&number)
    {
        Ok(number as u64)
    } else {
        Err(refused(
            GoalErrorCode::InvalidMaxRounds,
            "maxGoalRounds must be a positive safe integer",
        ))
    }
}

/// The cap, validated inside a logged snapshot.
fn logged_max_goal_rounds(value: Option<&Value>) -> Result<u64, GoalError> {
    match value.and_then(integer_of) {
        Some(number) if (1..=MAX_SAFE_INTEGER).contains(&number) => Ok(number),
        _ => Err(refused(
            GoalErrorCode::InvalidMaxRounds,
            "maxGoalRounds must be a positive safe integer",
        )),
    }
}

/// The objective for a `create` or an `edit`: trimmed, 1 to [`MAX_OBJECTIVE_LENGTH`] UTF-16 units.
fn valid_objective(text: &str) -> Result<String, GoalError> {
    if text.trim().is_empty() {
        return Err(invalid_log("objective must be a non-empty string"));
    }
    let objective = text.trim().to_owned();
    if objective.encode_utf16().count() > MAX_OBJECTIVE_LENGTH {
        return Err(refused(
            GoalErrorCode::InvalidObjective,
            format!("an objective must be at most {MAX_OBJECTIVE_LENGTH} characters"),
        ));
    }
    Ok(objective)
}

/// A block reason as a tool or a request body carries it.
fn valid_block_reason(value: &Value) -> Result<GoalBlockReason, GoalError> {
    let Some(object) = value.as_object() else {
        return Err(refused(
            GoalErrorCode::InvalidBlockReason,
            "a blocked goal needs { code, message }",
        ));
    };
    let code = object
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let lower_kebab = {
        let mut characters = code.chars();
        matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
            && characters.all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
    };
    if !lower_kebab {
        return Err(refused(
            GoalErrorCode::InvalidBlockReason,
            "a block reason code must be lower-kebab-case, for example \"missing-input\"",
        ));
    }
    let message_length = message.encode_utf16().count();
    if message_length == 0 || message_length > MAX_BLOCK_MESSAGE_LENGTH {
        return Err(refused(
            GoalErrorCode::InvalidBlockReason,
            format!("a block reason message must be 1 to {MAX_BLOCK_MESSAGE_LENGTH} characters"),
        ));
    }
    Ok(GoalBlockReason {
        code: code.to_owned(),
        message: message.to_owned(),
    })
}

/// A `{id, revision}` reference inside a log.
fn valid_ref(value: &Value) -> Result<GoalRef, GoalError> {
    let Some(object) = value.as_object() else {
        return Err(invalid_log("a goal reference needs { id, revision }"));
    };
    Ok(GoalRef {
        id: non_empty_string(object.get("id"), "goal id")?,
        revision: positive_integer(object.get("revision"), "goal revision")?,
    })
}

/// `String(event.clearedAt ?? '')`, the coercion the TypeScript build applies.
fn cleared_at_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => json_text(other),
    }
}

/// The operation's name, as it appears in a refusal.
fn operation_name(operation: GoalOperation) -> &'static str {
    match operation {
        GoalOperation::Create => "create",
        GoalOperation::Edit => "edit",
        GoalOperation::Pause => "pause",
        GoalOperation::Resume => "resume",
        GoalOperation::Complete => "complete",
        GoalOperation::Block => "block",
    }
}

/// Decode one session event: `Ok(None)` when it is not a `goal/change`; `GOAL_INVALID_LOG` when it is one
/// that does not decode — another version, an unknown operation or phase, a non-positive revision, a cap that
/// is not a positive safe integer (`GOAL_INVALID_MAX_ROUNDS`), a block reason that does not validate
/// (`GOAL_INVALID_BLOCK_REASON`), a reason without the blocked phase or the reverse, a negative
/// `roundsStarted`, missing times.
pub fn decode_goal_change(event: &Value) -> Result<Option<GoalChange>, GoalError> {
    let Some(object) = event.as_object() else {
        return Ok(None);
    };
    if object.get("type").and_then(Value::as_str) != Some(GOAL_CHANGE_EVENT) {
        return Ok(None);
    }
    if object.get("version") != Some(&Value::from(GOAL_CHANGE_VERSION)) {
        let shown = object
            .get("version")
            .map(version_text)
            .unwrap_or_else(|| "undefined".to_owned());
        return Err(invalid_log(format!(
            "unsupported goal change version {shown}"
        )));
    }
    let named = object
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("");
    if named == "clear" {
        let cleared = valid_ref(object.get("cleared").unwrap_or(&Value::Null))?;
        let cleared_at = cleared_at_text(object.get("clearedAt"));
        if cleared_at.is_empty() {
            return Err(invalid_log("a clear tombstone needs clearedAt"));
        }
        return Ok(Some(GoalChange::Clear {
            cleared,
            cleared_at,
        }));
    }
    let operation = match named {
        "create" => GoalOperation::Create,
        "edit" => GoalOperation::Edit,
        "pause" => GoalOperation::Pause,
        "resume" => GoalOperation::Resume,
        "complete" => GoalOperation::Complete,
        "block" => GoalOperation::Block,
        other => {
            return Err(invalid_log(format!(
                "unknown goal operation {}",
                json_text(&Value::String(other.to_owned()))
            )));
        }
    };
    let Some(goal) = object.get("goal").and_then(Value::as_object) else {
        return Err(invalid_log("a goal change needs a snapshot"));
    };
    let id = non_empty_string(goal.get("id"), "goal id")?;
    let revision = positive_integer(goal.get("revision"), "goal revision")?;
    let objective = non_empty_string(goal.get("objective"), "goal objective")?;
    let phase = match goal.get("phase").and_then(Value::as_str) {
        Some("active") => GoalPhase::Active,
        Some("paused") => GoalPhase::Paused,
        Some("blocked") => GoalPhase::Blocked,
        Some("complete") => GoalPhase::Complete,
        _ => {
            return Err(invalid_log(format!(
                "unknown goal phase {}",
                goal.get("phase")
                    .map(json_text)
                    .unwrap_or_else(|| "undefined".to_owned())
            )));
        }
    };
    let max_goal_rounds = logged_max_goal_rounds(goal.get("maxGoalRounds"))?;
    let blocked_reason = match goal.get("blockedReason") {
        Some(value) => Some(valid_block_reason(value)?),
        None => None,
    };
    if (phase == GoalPhase::Blocked) != blocked_reason.is_some() {
        return Err(invalid_log(
            "a blockedReason exists exactly while the phase is blocked",
        ));
    }
    let rounds_started = non_negative_integer(object.get("roundsStarted"), "roundsStarted")?;
    let created_at = non_empty_string(object.get("createdAt"), "createdAt")?;
    let updated_at = non_empty_string(object.get("updatedAt"), "updatedAt")?;
    Ok(Some(GoalChange::Snapshot {
        operation,
        goal: GoalSnapshot {
            id,
            revision,
            objective,
            phase,
            max_goal_rounds,
            blocked_reason,
        },
        rounds_started,
        created_at,
        updated_at,
    }))
}

/// Fold a session's events into its current goal — strictly.
///
/// Fails (`GOAL_INVALID_LOG`) rather than producing a plausible wrong state when: a create happens while a
/// non-complete goal is current, reuses an id, or starts at a revision other than 1; any other operation has no
/// current goal, changes the id, does not advance the revision by exactly one, changes the objective or the cap
/// without being an edit, or mutates a complete goal; a clear names another goal or a revision other than one
/// past the current; a recorded `roundsStarted` goes backwards for the same goal.
///
/// Rounds are counted **in log order, across revisions**, as DSH's `dsh-goal` fold does: a goal change carries the
/// count forward, and a user message whose `source` is `{kind:"goal", goalId, revision, round ≥ 1}` for the goal and
/// revision current at that point raises the count to its round. A cap is a cap for the goal, not for one revision.
/// The earlier fold counted only the final revision's messages after the loop and took the larger of that and the
/// recorded count, so after an edit the goal ran past its cap (R-developer-two-31: five rounds under a cap of three).
/// Two leniencies keep logs written before that fix replayable where DSH would refuse them: a round number that does
/// not exceed the count is not counted again, and a recorded count lower than the in-order count does not lower it.
pub fn fold_goal(events: &[Value]) -> Result<FoldedGoal, GoalError> {
    let mut goal: Option<GoalSnapshot> = None;
    let mut rounds_started = 0u64;
    // The count the last mutation of the current goal recorded; recorded counts may not go backwards.
    let mut recorded = 0u64;
    let mut created_at: Option<String> = None;
    let mut updated_at: Option<String> = None;
    let mut last_ref: Option<GoalRef> = None;
    let mut seen: std::collections::HashSet<GoalId> = std::collections::HashSet::new();

    for event in events {
        if let Some((goal_id, revision, round)) = goal_round_of(event) {
            if let Some(current) = &goal
                && current.id.as_str() == goal_id
                && current.revision == revision
                && round > rounds_started
            {
                rounds_started = round;
            }
            continue;
        }
        let Some(change) = decode_goal_change(event)? else {
            continue;
        };
        match change {
            GoalChange::Clear { cleared, .. } => {
                let Some(current) = &goal else {
                    return Err(invalid_log(
                        "a clear tombstone needs a current goal to clear",
                    ));
                };
                if cleared.id != current.id {
                    return Err(invalid_log(
                        "a clear tombstone must name the goal it clears",
                    ));
                }
                if cleared.revision != current.revision + 1 {
                    return Err(invalid_log(
                        "a clear tombstone revision must be one past the cleared goal",
                    ));
                }
                goal = None;
                rounds_started = 0;
                recorded = 0;
                created_at = None;
                updated_at = None;
                last_ref = Some(cleared);
            }
            GoalChange::Snapshot {
                operation,
                goal: next,
                rounds_started: next_rounds,
                created_at: next_created,
                updated_at: next_updated,
            } => {
                if operation == GoalOperation::Create {
                    if let Some(current) = &goal
                        && current.phase != GoalPhase::Complete
                    {
                        return Err(invalid_log(
                            "a goal cannot be created while another is not complete",
                        ));
                    }
                    if seen.contains(&next.id) {
                        return Err(invalid_log(format!(
                            "goal id {} was already used in this session",
                            next.id
                        )));
                    }
                    if next.revision != 1 {
                        return Err(invalid_log("a created goal starts at revision 1"));
                    }
                    seen.insert(next.id.clone());
                } else {
                    let Some(current) = &goal else {
                        return Err(invalid_log(format!(
                            "cannot {} a goal when none is current",
                            operation_name(operation)
                        )));
                    };
                    if next.id != current.id {
                        return Err(invalid_log(format!(
                            "goal {} changed the goal id",
                            operation_name(operation)
                        )));
                    }
                    if next.revision != current.revision + 1 {
                        return Err(invalid_log(format!(
                            "goal {} must advance the revision by one",
                            operation_name(operation)
                        )));
                    }
                    if operation != GoalOperation::Edit
                        && (next.objective != current.objective
                            || next.max_goal_rounds != current.max_goal_rounds)
                    {
                        return Err(invalid_log(format!(
                            "goal {} cannot change objective or maxGoalRounds",
                            operation_name(operation)
                        )));
                    }
                    if current.phase == GoalPhase::Complete {
                        return Err(invalid_log(
                            "a complete goal is not mutated; clear it and create a new one",
                        ));
                    }
                }
                let same_goal = last_ref.as_ref().is_some_and(|last| last.id == next.id);
                if next_rounds < recorded && same_goal {
                    return Err(invalid_log("roundsStarted cannot go backwards"));
                }
                rounds_started = if same_goal {
                    rounds_started.max(next_rounds)
                } else {
                    next_rounds
                };
                recorded = next_rounds;
                created_at = Some(next_created);
                updated_at = Some(next_updated);
                last_ref = Some(next.goal_ref());
                goal = Some(next);
            }
        }
    }

    Ok(FoldedGoal {
        goal,
        rounds_started,
        created_at,
        updated_at,
        last_ref,
    })
}

/// The goal round a goal-attributed user message announces — `(goalId, revision, round ≥ 1)` — or `None` for any
/// other event.
fn goal_round_of(event: &Value) -> Option<(&str, u64, u64)> {
    if event.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = event.get("message").and_then(Value::as_object)?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let source = message.get("source").and_then(Value::as_object)?;
    if source.get("kind").and_then(Value::as_str) != Some("goal") {
        return None;
    }
    let goal_id = source.get("goalId").and_then(Value::as_str)?;
    let revision = source.get("revision").and_then(integer_of)?;
    let round = source
        .get("round")
        .and_then(integer_of)
        .filter(|round| *round >= 1)?;
    Some((goal_id, revision, round))
}

/// The body a change appends, in the TypeScript key order: `{type, version, operation, goal, roundsStarted,
/// createdAt, updatedAt}` for a snapshot, `{type, version, operation:"clear", cleared, clearedAt}` for a clear.
pub fn goal_change_event(change: &GoalChange) -> Map<String, Value> {
    let mut event = Map::new();
    event.insert(
        "type".to_owned(),
        Value::String(GOAL_CHANGE_EVENT.to_owned()),
    );
    event.insert("version".to_owned(), Value::from(GOAL_CHANGE_VERSION));
    match change {
        GoalChange::Snapshot {
            operation,
            goal,
            rounds_started,
            created_at,
            updated_at,
        } => {
            event.insert(
                "operation".to_owned(),
                serde_json::to_value(operation).expect("an operation is plain data"),
            );
            event.insert(
                "goal".to_owned(),
                serde_json::to_value(goal).expect("a snapshot is plain data"),
            );
            event.insert("roundsStarted".to_owned(), Value::from(*rounds_started));
            event.insert("createdAt".to_owned(), Value::String(created_at.clone()));
            event.insert("updatedAt".to_owned(), Value::String(updated_at.clone()));
        }
        GoalChange::Clear {
            cleared,
            cleared_at,
        } => {
            event.insert("operation".to_owned(), Value::String("clear".to_owned()));
            event.insert(
                "cleared".to_owned(),
                serde_json::to_value(cleared).expect("a reference is plain data"),
            );
            event.insert("clearedAt".to_owned(), Value::String(cleared_at.clone()));
        }
    }
    event
}

/// The goal plugin's configuration row. Camel-case keys, as the TypeScript schema.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GoalConfig {
    /// The cap `create` uses when none is named; [`DEFAULT_MAX_GOAL_ROUNDS`].
    pub default_max_goal_rounds: u64,
}

impl Default for GoalConfig {
    fn default() -> Self {
        Self {
            default_max_goal_rounds: DEFAULT_MAX_GOAL_ROUNDS,
        }
    }
}

/// A `create` request. Numbers are JavaScript numbers (`f64`), so the service refuses `2.5`, `0` and anything
/// past 2⁵³−1 exactly as the TypeScript build does.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CreateGoal {
    /// The objective; trimmed before it is stored.
    pub objective: String,
    /// The cap; the configured default when `None`.
    pub max_goal_rounds: Option<f64>,
}

/// An `edit` request: at least one of the two.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EditGoal {
    /// A new objective.
    pub objective: Option<String>,
    /// A new cap.
    pub max_goal_rounds: Option<f64>,
}

/// Where a new goal's id comes from; injected so a test can fix it.
pub trait GoalIds: Send + Sync {
    /// A fresh id, `goal-<uuid v4>`.
    fn next_id(&self) -> GoalId;
}

/// Random `goal-<uuid v4>` ids, as the TypeScript `randomUUID`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RandomGoalIds;

impl GoalIds for RandomGoalIds {
    fn next_id(&self) -> GoalId {
        use std::io::Read;

        let mut bytes = [0u8; 16];
        let read =
            std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes));
        if read.is_err() {
            // A platform without /dev/urandom: seed from the time and the process, still a v4 shape.
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            bytes[..8].copy_from_slice(&(nanos as u64).to_le_bytes());
            bytes[8..].copy_from_slice(&(std::process::id() as u64).to_le_bytes());
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        format!(
            "goal-{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        )
    }
}

/// The goal service: append-only mutations, a strict fold, and process-local activation.
///
/// `Send + Sync`, shared as an `Arc` by the tools, the routes and the driver. Every mutation reads, folds and
/// appends under one lock, so two concurrent writers cannot both write revision *n + 1* — the TypeScript build
/// gets that from its single thread.
pub struct GoalService {
    log: Arc<dyn SessionLog>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn GoalIds>,
    default_max_goal_rounds: u64,
    /// Per-session overrides; absent means "derive from the durable phase" (an `active` goal is armed).
    activation: Mutex<HashMap<String, GoalActivation>>,
    /// Serializes read-fold-append.
    writing: Mutex<()>,
}

impl GoalService {
    /// The service over `log`, with the system clock and random ids.
    pub fn new(log: Arc<dyn SessionLog>, config: GoalConfig) -> Self {
        Self {
            log,
            clock: Arc::new(SystemClock),
            ids: Arc::new(RandomGoalIds),
            default_max_goal_rounds: config.default_max_goal_rounds,
            activation: Mutex::new(HashMap::new()),
            writing: Mutex::new(()),
        }
    }

    /// The same service with another clock — for tests.
    pub fn with_clock(self, clock: Arc<dyn Clock>) -> Self {
        Self { clock, ..self }
    }

    /// The same service with another id source — for tests.
    pub fn with_ids(self, ids: Arc<dyn GoalIds>) -> Self {
        Self { ids, ..self }
    }

    /// The session log the service reads, for the routes' session lookup.
    pub fn log(&self) -> &dyn SessionLog {
        self.log.as_ref()
    }

    /// The current goal, or `None` when none is current.
    pub fn get(&self, session: &str) -> Result<Option<GoalView>, GoalError> {
        let session = self.session_of(session)?;
        let folded = self.fold_session(&session)?;
        Ok(self.view_of(&session, &folded))
    }

    /// The session's log, as the goal tools read it to decide **who is asking**.
    ///
    /// Authority is judged on the same log the fold reads, and through the same port: a direct human turn is a
    /// person's message in the open turn, and a goal round is the driver's sourced message for the goal's current
    /// revision and round. Reading it here keeps the tools on the service they already hold.
    pub fn session_events(&self, session: &str) -> Result<Vec<Value>, GoalError> {
        let session = self.session_of(session)?;
        Ok(self.log.read(&session)?)
    }

    /// The session's metadata record, which says whether it is a delegated (subagent or teammate) session; `None`
    /// when there is no such session or the log keeps no record ([`SessionLog::meta`]).
    pub fn session_meta(&self, session: &str) -> Option<Value> {
        let session = self.log.open(session)?;
        self.log.meta(&session)
    }

    /// Remove this process's continuation authority without changing the phase or the revision.
    pub fn disarm(&self, session: &str) -> Result<Option<GoalView>, GoalError> {
        let session = self.session_of(session)?;
        let folded = self.fold_session(&session)?;
        if folded.goal.is_none() {
            return Ok(None);
        }
        self.set_activation(&session, GoalActivation::Disarmed);
        Ok(self.view_of(&session, &folded))
    }

    /// Create and arm a goal. A complete goal may be replaced; anything else is `GOAL_ALREADY_EXISTS`.
    pub fn create(&self, session: &str, request: CreateGoal) -> Result<GoalView, GoalError> {
        let session = self.session_of(session)?;
        let _writing = self.lock_writing();
        let folded = self.fold_session(&session)?;
        if let Some(current) = &folded.goal
            && current.phase != GoalPhase::Complete
        {
            return Err(refused(
                GoalErrorCode::AlreadyExists,
                format!(
                    "goal {} already exists with phase {}; clear or resume it",
                    current.id,
                    current.phase.as_str()
                ),
            ));
        }
        let objective = valid_objective(&request.objective)?;
        let max_goal_rounds = match request.max_goal_rounds {
            Some(number) => valid_max_goal_rounds(number)?,
            None => valid_max_goal_rounds(self.default_max_goal_rounds as f64)?,
        };
        let now = self.clock.now();
        let snapshot = GoalSnapshot {
            id: self.ids.next_id(),
            revision: 1,
            objective,
            phase: GoalPhase::Active,
            max_goal_rounds,
            blocked_reason: None,
        };
        self.append(
            &session,
            GoalChange::Snapshot {
                operation: GoalOperation::Create,
                goal: snapshot,
                rounds_started: 0,
                created_at: now.clone(),
                updated_at: now,
            },
        )?;
        self.set_activation(&session, GoalActivation::Armed);
        let folded = self.fold_session(&session)?;
        Ok(self
            .view_of(&session, &folded)
            .expect("a created goal is current"))
    }

    /// Change the objective and/or the cap, keeping the phase; `GOAL_INVALID_EDIT` when the request names neither.
    pub fn edit(
        &self,
        session: &str,
        goal: &GoalRef,
        request: EditGoal,
    ) -> Result<GoalView, GoalError> {
        let session = self.session_of(session)?;
        let _writing = self.lock_writing();
        let folded = self.fold_session(&session)?;
        let current = expect_current(&folded, goal)?.clone();
        if request.objective.is_none() && request.max_goal_rounds.is_none() {
            // DSH's sentence (dsh-goal `edit`), which the model reads back through `update_goal`.
            return Err(refused(
                GoalErrorCode::InvalidEdit,
                "goal edit requires objective and/or maxGoalRounds",
            ));
        }
        let objective = match request.objective {
            Some(text) => valid_objective(&text)?,
            None => current.objective.clone(),
        };
        let max_goal_rounds = match request.max_goal_rounds {
            Some(number) => valid_max_goal_rounds(number)?,
            None => current.max_goal_rounds,
        };
        let next = GoalSnapshot {
            revision: current.revision + 1,
            objective,
            max_goal_rounds,
            ..current
        };
        self.commit(&session, &folded, GoalOperation::Edit, next)?;
        let folded = self.fold_session(&session)?;
        Ok(self
            .view_of(&session, &folded)
            .expect("an edited goal is current"))
    }

    /// Pause an active goal and disarm it.
    pub fn pause(&self, session: &str, goal: &GoalRef) -> Result<GoalView, GoalError> {
        self.transition(
            session,
            goal,
            GoalOperation::Pause,
            &[GoalPhase::Active],
            GoalPhase::Paused,
        )
    }

    /// Resume a paused, blocked, or active-but-disarmed goal and arm it. Refused when it is active and armed
    /// already, and when its rounds are exhausted (the honest next state is `complete` or a higher cap).
    pub fn resume(&self, session: &str, goal: &GoalRef) -> Result<GoalView, GoalError> {
        let session = self.session_of(session)?;
        let _writing = self.lock_writing();
        let folded = self.fold_session(&session)?;
        let current = expect_current(&folded, goal)?.clone();
        let resumable = [GoalPhase::Active, GoalPhase::Paused, GoalPhase::Blocked];
        if !resumable.contains(&current.phase) {
            return Err(transition_error(&current, "resume", &resumable));
        }
        if current.phase == GoalPhase::Active
            && self.activation_of(&session, &current) == GoalActivation::Armed
        {
            return Err(refused(
                GoalErrorCode::InvalidTransition,
                format!("goal {} is already active and armed", current.id),
            ));
        }
        if folded.rounds_started >= current.max_goal_rounds {
            return Err(refused(
                GoalErrorCode::InvalidTransition,
                format!(
                    "goal {} exhausted {} rounds; raise maxGoalRounds or complete it",
                    current.id, current.max_goal_rounds
                ),
            ));
        }
        let next = GoalSnapshot {
            revision: current.revision + 1,
            phase: GoalPhase::Active,
            blocked_reason: None,
            ..current
        };
        self.commit(&session, &folded, GoalOperation::Resume, next)?;
        self.set_activation(&session, GoalActivation::Armed);
        let folded = self.fold_session(&session)?;
        Ok(self
            .view_of(&session, &folded)
            .expect("a resumed goal is current"))
    }

    /// Mark a non-complete goal complete and disarm it.
    pub fn complete(&self, session: &str, goal: &GoalRef) -> Result<GoalView, GoalError> {
        self.transition(
            session,
            goal,
            GoalOperation::Complete,
            &[GoalPhase::Active, GoalPhase::Paused, GoalPhase::Blocked],
            GoalPhase::Complete,
        )
    }

    /// Mark an **active** goal blocked with `reason` — raw, as a tool or a request body carries it, validated
    /// after the reference and the transition (`{code: lower-kebab-case, message: 1..2000}`) — and disarm it.
    pub fn block(
        &self,
        session: &str,
        goal: &GoalRef,
        reason: &Value,
    ) -> Result<GoalView, GoalError> {
        let session = self.session_of(session)?;
        let _writing = self.lock_writing();
        let folded = self.fold_session(&session)?;
        let current = expect_current(&folded, goal)?.clone();
        if current.phase != GoalPhase::Active {
            return Err(transition_error(&current, "block", &[GoalPhase::Active]));
        }
        let reason = valid_block_reason(reason)?;
        let next = GoalSnapshot {
            revision: current.revision + 1,
            phase: GoalPhase::Blocked,
            blocked_reason: Some(reason),
            ..current
        };
        self.commit(&session, &folded, GoalOperation::Block, next)?;
        self.set_activation(&session, GoalActivation::Disarmed);
        let folded = self.fold_session(&session)?;
        Ok(self
            .view_of(&session, &folded)
            .expect("a blocked goal is current"))
    }

    /// Clear the current goal, writing a tombstone one revision past it; returns the tombstone's reference.
    pub fn clear(&self, session: &str, goal: &GoalRef) -> Result<GoalRef, GoalError> {
        let session = self.session_of(session)?;
        let _writing = self.lock_writing();
        let folded = self.fold_session(&session)?;
        let current = expect_current(&folded, goal)?.clone();
        let tombstone = GoalRef {
            id: current.id.clone(),
            revision: current.revision + 1,
        };
        self.append(
            &session,
            GoalChange::Clear {
                cleared: tombstone.clone(),
                cleared_at: self.clock.now(),
            },
        )?;
        self.set_activation(&session, GoalActivation::Disarmed);
        Ok(tombstone)
    }

    /// The single shared phase transition: the allowed-from check, then a commit and a disarm.
    fn transition(
        &self,
        session: &str,
        goal: &GoalRef,
        operation: GoalOperation,
        allowed: &[GoalPhase],
        phase: GoalPhase,
    ) -> Result<GoalView, GoalError> {
        let session = self.session_of(session)?;
        let _writing = self.lock_writing();
        let folded = self.fold_session(&session)?;
        let current = expect_current(&folded, goal)?.clone();
        if !allowed.contains(&current.phase) {
            return Err(transition_error(
                &current,
                operation_name(operation),
                allowed,
            ));
        }
        let next = GoalSnapshot {
            revision: current.revision + 1,
            phase,
            ..current
        };
        self.commit(&session, &folded, operation, next)?;
        self.set_activation(
            &session,
            if operation == GoalOperation::Resume {
                GoalActivation::Armed
            } else {
                GoalActivation::Disarmed
            },
        );
        let folded = self.fold_session(&session)?;
        Ok(self
            .view_of(&session, &folded)
            .expect("the committed goal is current"))
    }

    /// Resolve the session the caller named, so every method works on the canonical id.
    fn session_of(&self, session: &str) -> Result<String, GoalError> {
        self.log
            .open(session)
            .ok_or_else(|| GoalError::Log(LogError(format!("no session {session}"))))
    }

    /// Fold one canonical session's log.
    fn fold_session(&self, session: &str) -> Result<FoldedGoal, GoalError> {
        let events = self.log.read(session)?;
        fold_goal(&events)
    }

    /// The lock that makes read-fold-append one atomic step.
    fn lock_writing(&self) -> std::sync::MutexGuard<'_, ()> {
        self.writing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set_activation(&self, session: &str, activation: GoalActivation) {
        self.activation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session.to_owned(), activation);
    }

    /// The process-local activation, defaulting from the durable phase: an `active` goal is armed again by a
    /// new process, which is the owner's rule that goal pushing survives a restart.
    fn activation_of(&self, session: &str, goal: &GoalSnapshot) -> GoalActivation {
        self.activation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session)
            .copied()
            .unwrap_or(if goal.phase == GoalPhase::Active {
                GoalActivation::Armed
            } else {
                GoalActivation::Disarmed
            })
    }

    /// The view a reader sees, or `None` when no goal is current.
    fn view_of(&self, session: &str, folded: &FoldedGoal) -> Option<GoalView> {
        let goal = folded.goal.clone()?;
        Some(GoalView {
            activation: self.activation_of(session, &goal),
            goal,
            rounds_started: folded.rounds_started,
            created_at: folded.created_at.clone().unwrap_or_default(),
            updated_at: folded.updated_at.clone().unwrap_or_default(),
        })
    }

    /// Append one change.
    fn append(&self, session: &str, change: GoalChange) -> Result<Value, GoalError> {
        Ok(self.log.append(session, goal_change_event(&change))?)
    }

    /// Commit one snapshot change, keeping the goal's own derived counters and times, and dropping a block
    /// reason when the phase is no longer blocked.
    fn commit(
        &self,
        session: &str,
        folded: &FoldedGoal,
        operation: GoalOperation,
        goal: GoalSnapshot,
    ) -> Result<(), GoalError> {
        let snapshot = if goal.phase == GoalPhase::Blocked {
            goal
        } else {
            GoalSnapshot {
                blocked_reason: None,
                ..goal
            }
        };
        let now = self.clock.now();
        self.append(
            session,
            GoalChange::Snapshot {
                operation,
                goal: snapshot,
                rounds_started: folded.rounds_started,
                created_at: folded.created_at.clone().unwrap_or_else(|| now.clone()),
                updated_at: now,
            },
        )?;
        Ok(())
    }
}

/// The current goal a compare-and-set reference must name.
fn expect_current<'a>(
    folded: &'a FoldedGoal,
    reference: &GoalRef,
) -> Result<&'a GoalSnapshot, GoalError> {
    let Some(current) = &folded.goal else {
        return Err(refused(
            GoalErrorCode::NotFound,
            format!("no goal {} is current", reference.id),
        ));
    };
    if current.id != reference.id {
        return Err(refused(
            GoalErrorCode::NotFound,
            format!(
                "goal {} is not the current goal ({})",
                reference.id, current.id
            ),
        ));
    }
    if current.revision != reference.revision {
        return Err(refused(
            GoalErrorCode::StaleRevision,
            format!(
                "goal {} is at revision {}, not {}; read it again",
                reference.id, current.revision, reference.revision
            ),
        ));
    }
    Ok(current)
}

/// The refusal a disallowed phase transition produces.
fn transition_error(current: &GoalSnapshot, operation: &str, allowed: &[GoalPhase]) -> GoalError {
    let allowed: Vec<&str> = allowed.iter().map(|phase| phase.as_str()).collect();
    refused(
        GoalErrorCode::InvalidTransition,
        format!(
            "cannot {operation} goal {} from phase {}; expected {}",
            current.id,
            current.phase.as_str(),
            allowed.join(" or ")
        ),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::{FIXED_NOW, fixture};

    fn code_of(error: &GoalError) -> &'static str {
        error.code().expect("a refusal").as_str()
    }

    fn objective_of(view: &GoalView) -> &str {
        &view.goal.objective
    }

    #[test]
    fn a_goal_lives_in_the_log_and_folds_back_to_the_same_snapshot() {
        let (log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "ship the goal feature".into(),
                    max_goal_rounds: Some(4.0),
                },
            )
            .unwrap();
        assert_eq!(objective_of(&created), "ship the goal feature");
        assert_eq!(created.goal.phase, GoalPhase::Active);
        assert_eq!(created.activation, GoalActivation::Armed);
        assert_eq!(created.goal.revision, 1);
        assert_eq!(created.rounds_started, 0);
        assert_eq!(created.goal.max_goal_rounds, 4);
        assert_eq!(created.created_at, FIXED_NOW);

        let changes = log
            .events("s1")
            .into_iter()
            .filter(|event| event["type"] == "goal/change")
            .count();
        assert_eq!(changes, 1, "one mutation, one event");
        let folded = fold_goal(&log.events("s1")).unwrap();
        assert_eq!(folded.goal, Some(created.goal.clone()));
    }

    #[test]
    fn every_mutation_appends_a_full_snapshot_and_advances_the_revision() {
        let (log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        let paused = service
            .pause(
                "s1",
                &GoalRef {
                    id: created.goal.id.clone(),
                    revision: created.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(paused.goal.phase, GoalPhase::Paused);
        assert_eq!(paused.activation, GoalActivation::Disarmed);
        assert_eq!(paused.goal.revision, 2);
        let resumed = service
            .resume(
                "s1",
                &GoalRef {
                    id: paused.goal.id.clone(),
                    revision: paused.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(resumed.goal.phase, GoalPhase::Active);
        assert_eq!(resumed.activation, GoalActivation::Armed);
        assert_eq!(resumed.goal.revision, 3);
        assert_eq!(
            log.events("s1")
                .iter()
                .filter(|event| event["type"] == "goal/change")
                .count(),
            3
        );
    }

    #[test]
    fn a_stale_revision_is_refused_rather_than_overwriting_a_newer_one() {
        let (_log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        service
            .pause(
                "s1",
                &GoalRef {
                    id: created.goal.id.clone(),
                    revision: 1,
                },
            )
            .unwrap();
        let error = service
            .complete(
                "s1",
                &GoalRef {
                    id: created.goal.id,
                    revision: 1,
                },
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_STALE_REVISION");
        assert!(error.to_string().contains("read it again"));
    }

    #[test]
    fn a_goal_cannot_be_created_while_another_is_live_but_may_replace_a_completed_one() {
        let (_log, service) = fixture("s1");
        let first = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        let error = service
            .create(
                "s1",
                CreateGoal {
                    objective: "two".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_ALREADY_EXISTS");

        let done = service
            .complete(
                "s1",
                &GoalRef {
                    id: first.goal.id.clone(),
                    revision: first.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(done.goal.phase, GoalPhase::Complete);
        let second = service
            .create(
                "s1",
                CreateGoal {
                    objective: "two".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        assert_ne!(
            second.goal.id, first.goal.id,
            "a replacement is a new identity"
        );
        assert_eq!(second.goal.revision, 1);
    }

    #[test]
    fn the_transition_table_refuses_what_dsh_refuses() {
        let (_log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        let reference = GoalRef {
            id: created.goal.id.clone(),
            revision: created.goal.revision,
        };
        let paused = service.pause("s1", &reference).unwrap();
        assert_eq!(paused.goal.phase, GoalPhase::Paused);
        let error = service
            .pause(
                "s1",
                &GoalRef {
                    id: paused.goal.id.clone(),
                    revision: paused.goal.revision,
                },
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_TRANSITION");

        let resumed = service
            .resume(
                "s1",
                &GoalRef {
                    id: paused.goal.id.clone(),
                    revision: paused.goal.revision,
                },
            )
            .unwrap();
        let error = service
            .resume(
                "s1",
                &GoalRef {
                    id: resumed.goal.id.clone(),
                    revision: resumed.goal.revision,
                },
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_TRANSITION");
        assert_eq!(
            error.to_string(),
            format!("goal {} is already active and armed", resumed.goal.id)
        );

        let paused_again = service
            .pause(
                "s1",
                &GoalRef {
                    id: resumed.goal.id.clone(),
                    revision: resumed.goal.revision,
                },
            )
            .unwrap();
        let error = service
            .block(
                "s1",
                &GoalRef {
                    id: paused_again.goal.id.clone(),
                    revision: paused_again.goal.revision,
                },
                &json!({"code": "missing-input", "message": "needs a key"}),
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_TRANSITION");

        let done = service
            .complete(
                "s1",
                &GoalRef {
                    id: paused_again.goal.id.clone(),
                    revision: paused_again.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(done.goal.phase, GoalPhase::Complete);
        assert_eq!(done.activation, GoalActivation::Disarmed);
    }

    #[test]
    fn resume_refuses_an_exhausted_round_budget() {
        let (log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: Some(1.0),
                },
            )
            .unwrap();
        log.append_raw(
            "s1",
            json!({"type": "message", "message": {
                "role": "user",
                "content": [{"type": "text", "text": "continue"}],
                "source": {"kind": "goal", "goalId": created.goal.id, "revision": created.goal.revision, "round": 1}
            }}),
        );
        let paused = service
            .pause(
                "s1",
                &GoalRef {
                    id: created.goal.id.clone(),
                    revision: created.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(
            paused.rounds_started, 1,
            "the fold counts the admitted round"
        );
        let error = service
            .resume(
                "s1",
                &GoalRef {
                    id: paused.goal.id.clone(),
                    revision: paused.goal.revision,
                },
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_TRANSITION");
        assert!(error.to_string().contains("exhausted"));
    }

    #[test]
    fn a_block_needs_a_lower_kebab_code_and_a_message() {
        let (_log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        let reference = GoalRef {
            id: created.goal.id.clone(),
            revision: created.goal.revision,
        };
        let error = service
            .block(
                "s1",
                &reference,
                &json!({"code": "Not A Code", "message": "x"}),
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_BLOCK_REASON");
        let error = service
            .block(
                "s1",
                &reference,
                &json!({"code": "missing-input", "message": "   "}),
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_BLOCK_REASON");
        let blocked = service
            .block(
                "s1",
                &reference,
                &json!({"code": "missing-input", "message": "needs a key"}),
            )
            .unwrap();
        assert_eq!(blocked.goal.phase, GoalPhase::Blocked);
        assert_eq!(
            blocked.goal.blocked_reason,
            Some(GoalBlockReason {
                code: "missing-input".into(),
                message: "needs a key".into()
            })
        );
        assert_eq!(blocked.activation, GoalActivation::Disarmed);

        let done = service
            .complete(
                "s1",
                &GoalRef {
                    id: blocked.goal.id.clone(),
                    revision: blocked.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(
            done.goal.blocked_reason, None,
            "leaving blocked drops the reason"
        );
    }

    #[test]
    fn only_edit_may_change_the_definition_and_clear_leaves_a_tombstone() {
        let (log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: Some(3.0),
                },
            )
            .unwrap();
        let edited = service
            .edit(
                "s1",
                &GoalRef {
                    id: created.goal.id.clone(),
                    revision: 1,
                },
                EditGoal {
                    objective: Some("one, better".into()),
                    max_goal_rounds: Some(5.0),
                },
            )
            .unwrap();
        assert_eq!(edited.goal.objective, "one, better");
        assert_eq!(edited.goal.max_goal_rounds, 5);
        assert_eq!(edited.goal.revision, 2);

        let cleared = service
            .clear(
                "s1",
                &GoalRef {
                    id: edited.goal.id.clone(),
                    revision: edited.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(
            cleared,
            GoalRef {
                id: edited.goal.id.clone(),
                revision: 3
            }
        );
        let folded = fold_goal(&log.events("s1")).unwrap();
        assert_eq!(folded.goal, None, "the goal is gone");
        assert_eq!(folded.last_ref, Some(cleared), "but the tombstone survives");
        assert_eq!(service.get("s1").unwrap(), None);
    }

    #[test]
    fn an_edit_with_neither_field_is_refused() {
        let (_log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        let error = service
            .edit(
                "s1",
                &GoalRef {
                    id: created.goal.id,
                    revision: 1,
                },
                EditGoal::default(),
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_EDIT");
    }

    #[test]
    fn an_active_goal_is_armed_again_in_a_new_process_and_a_paused_one_is_not() {
        let (log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: Some(2.0),
                },
            )
            .unwrap();
        let reopened = GoalService::new(log.clone(), GoalConfig::default());
        let view = reopened.get("s1").unwrap().expect("the durable goal");
        assert_eq!(view.goal.id, created.goal.id);
        assert_eq!(view.activation, GoalActivation::Armed);

        log.create("s2");
        let paused_goal = service
            .create(
                "s2",
                CreateGoal {
                    objective: "two".into(),
                    max_goal_rounds: Some(2.0),
                },
            )
            .unwrap();
        service
            .pause(
                "s2",
                &GoalRef {
                    id: paused_goal.goal.id,
                    revision: 1,
                },
            )
            .unwrap();
        let reopened = GoalService::new(log.clone(), GoalConfig::default());
        assert_eq!(
            reopened.get("s2").unwrap().unwrap().activation,
            GoalActivation::Disarmed
        );
    }

    #[test]
    fn a_disarm_keeps_the_phase_and_the_revision() {
        let (_log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        assert_eq!(created.activation, GoalActivation::Armed);
        let disarmed = service.disarm("s1").unwrap().unwrap();
        assert_eq!(disarmed.goal.phase, GoalPhase::Active);
        assert_eq!(disarmed.goal.revision, 1);
        assert_eq!(disarmed.activation, GoalActivation::Disarmed);
        assert_eq!(
            service.get("s1").unwrap().unwrap().activation,
            GoalActivation::Disarmed,
            "the process-local override holds"
        );
    }

    #[test]
    fn a_goal_created_without_a_cap_gets_the_default_and_it_is_100() {
        let (_log, service) = fixture("s1");
        let implicit = service
            .create(
                "s1",
                CreateGoal {
                    objective: "no cap named".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        assert_eq!(implicit.goal.max_goal_rounds, 100);
    }

    #[test]
    fn an_objective_is_trimmed_and_has_a_length_limit() {
        let (log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "  one  ".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        assert_eq!(created.goal.objective, "one");
        // A second session, because a create is refused while another goal is live in the same one.
        log.create("s2");
        let error = service
            .create(
                "s2",
                CreateGoal {
                    objective: " ".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_LOG");
        let error = service
            .create(
                "s2",
                CreateGoal {
                    objective: "x".repeat(8001),
                    max_goal_rounds: None,
                },
            )
            .unwrap_err();
        assert_eq!(code_of(&error), "GOAL_INVALID_OBJECTIVE");
        assert!(error.to_string().contains("at most 8000"));
    }

    fn change(
        operation: &str,
        revision: u64,
        objective: &str,
        phase: &str,
        rounds_started: u64,
        max_goal_rounds: u64,
    ) -> Value {
        json!({
            "type": "goal/change",
            "version": 1,
            "operation": operation,
            "goal": {
                "id": "goal-x",
                "revision": revision,
                "objective": objective,
                "phase": phase,
                "maxGoalRounds": max_goal_rounds
            },
            "roundsStarted": rounds_started,
            "createdAt": FIXED_NOW,
            "updatedAt": FIXED_NOW
        })
    }

    #[test]
    fn the_fold_refuses_a_log_that_does_not_decode() {
        let cases: Vec<(Vec<Value>, &str)> = vec![
            (
                vec![json!({"type": "goal/change", "version": 99})],
                "unsupported goal change version 99",
            ),
            (
                vec![json!({"type": "goal/change", "version": 1, "operation": "dance"})],
                "unknown goal operation \"dance\"",
            ),
            (
                vec![
                    change("create", 1, "one", "active", 0, 4),
                    change("edit", 3, "one", "active", 0, 4),
                ],
                "goal edit must advance the revision by one",
            ),
            (
                vec![
                    change("create", 1, "one", "active", 0, 4),
                    change("pause", 2, "other", "paused", 0, 4),
                ],
                "goal pause cannot change objective or maxGoalRounds",
            ),
            (
                vec![
                    change("create", 1, "one", "active", 0, 4),
                    change("complete", 2, "one", "complete", 0, 4),
                    change("pause", 3, "one", "paused", 0, 4),
                ],
                "a complete goal is not mutated; clear it and create a new one",
            ),
            (
                vec![json!({
                    "type": "goal/change",
                    "version": 1,
                    "operation": "clear",
                    "cleared": {"id": "goal-x", "revision": 2},
                    "clearedAt": FIXED_NOW
                })],
                "a clear tombstone needs a current goal to clear",
            ),
            (
                vec![
                    change("create", 1, "one", "active", 5, 4),
                    change("edit", 2, "one", "active", 4, 4),
                ],
                "roundsStarted cannot go backwards",
            ),
            (
                vec![change("create", 1, "one", "blocked", 0, 4)],
                "a blockedReason exists exactly while the phase is blocked",
            ),
        ];
        for (events, message) in cases {
            let error = fold_goal(&events).unwrap_err();
            assert_eq!(code_of(&error), "GOAL_INVALID_LOG", "{message}");
            assert!(error.to_string().contains(message), "{}", error.to_string());
        }
    }

    #[test]
    fn the_fold_counts_admitted_rounds_for_the_exact_revision() {
        let (log, service) = fixture("s1");
        let created = service
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        let message = |revision: u64, round: u64| {
            json!({"type": "message", "message": {
                "role": "user",
                "content": [{"type": "text", "text": "continue"}],
                "source": {"kind": "goal", "goalId": created.goal.id, "revision": revision, "round": round}
            }})
        };
        log.append_raw("s1", message(1, 1));
        log.append_raw("s1", message(1, 2));
        log.append_raw("s1", message(2, 1));
        log.append_raw("s1", message(1, 0));
        log.append_raw(
            "s1",
            json!({"type": "message", "message": {"role": "user", "content": []}}),
        );
        assert_eq!(service.get("s1").unwrap().unwrap().rounds_started, 2);
    }

    #[test]
    fn a_goal_id_is_a_v4_uuid() {
        let ids = RandomGoalIds;
        let first = ids.next_id();
        let second = ids.next_id();
        assert!(first.starts_with("goal-"), "saw {first}");
        assert_eq!(first.len(), 41, "goal- plus a canonical uuid");
        assert_eq!(first.chars().nth(19), Some('4'), "the version nibble");
        assert!(
            matches!(first.chars().nth(24), Some('8' | '9' | 'a' | 'b')),
            "the variant nibble: {first}"
        );
        assert_ne!(first, second);
    }

    #[test]
    fn a_change_event_has_the_typescript_keys() {
        let snapshot = GoalSnapshot {
            id: "goal-x".into(),
            revision: 3,
            objective: "one".into(),
            phase: GoalPhase::Paused,
            max_goal_rounds: 4,
            blocked_reason: None,
        };
        let event = goal_change_event(&GoalChange::Snapshot {
            operation: GoalOperation::Pause,
            goal: snapshot,
            rounds_started: 2,
            created_at: FIXED_NOW.into(),
            updated_at: FIXED_NOW.into(),
        });
        assert_eq!(event["type"], "goal/change");
        assert_eq!(event["version"], 1);
        assert_eq!(event["operation"], "pause");
        assert_eq!(event["goal"]["revision"], 3);
        assert_eq!(event["roundsStarted"], 2);
        assert_eq!(event["createdAt"], FIXED_NOW);
        assert_eq!(event["updatedAt"], FIXED_NOW);

        let clear = goal_change_event(&GoalChange::Clear {
            cleared: GoalRef {
                id: "goal-x".into(),
                revision: 4,
            },
            cleared_at: FIXED_NOW.into(),
        });
        assert_eq!(clear["operation"], "clear");
        assert_eq!(clear["cleared"]["revision"], 4);
        assert_eq!(clear["clearedAt"], FIXED_NOW);
    }

    #[test]
    fn an_unknown_session_is_a_log_failure() {
        let (_log, service) = fixture("s1");
        let error = service.get("nobody").unwrap_err();
        assert_eq!(error.code(), None);
        assert_eq!(error.to_string(), "no session nobody");
    }
}
