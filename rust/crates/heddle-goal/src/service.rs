//! The event-sourced state machine: the `goal/change` shape, the strict fold, and the service.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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

/// Decode one session event: `Ok(None)` when it is not a `goal/change`; `GOAL_INVALID_LOG` when it is one
/// that does not decode — another version, an unknown operation or phase, a non-positive revision, a cap that
/// is not a positive safe integer (`GOAL_INVALID_MAX_ROUNDS`), a block reason that does not validate
/// (`GOAL_INVALID_BLOCK_REASON`), a reason without the blocked phase or the reverse, a negative
/// `roundsStarted`, missing times.
pub fn decode_goal_change(event: &Value) -> Result<Option<GoalChange>, GoalError> {
    let _ = event;
    todo!("heddle-goal: decode_goal_change")
}

/// Fold a session's events into its current goal — strictly.
///
/// Fails (`GOAL_INVALID_LOG`) rather than producing a plausible wrong state when: a create happens while a
/// non-complete goal is current, reuses an id, or starts at a revision other than 1; any other operation has no
/// current goal, changes the id, does not advance the revision by exactly one, changes the objective or the cap
/// without being an edit, or mutates a complete goal; a clear names another goal or a revision other than one
/// past the current; `roundsStarted` goes backwards for the same goal. The rounds of the current goal are then
/// raised to the count of user messages whose `source` is `{kind:"goal", goalId, revision, round ≥ 1}` for its
/// exact id and revision.
pub fn fold_goal(events: &[Value]) -> Result<FoldedGoal, GoalError> {
    let _ = events;
    todo!("heddle-goal: fold_goal")
}

/// The body a change appends, in the TypeScript key order: `{type, version, operation, goal, roundsStarted,
/// createdAt, updatedAt}` for a snapshot, `{type, version, operation:"clear", cleared, clearedAt}` for a clear.
pub fn goal_change_event(change: &GoalChange) -> Map<String, Value> {
    let _ = change;
    todo!("heddle-goal: goal_change_event")
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
        todo!("heddle-goal: RandomGoalIds")
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
        let _ = (
            session,
            &self.activation,
            &self.clock,
            &self.ids,
            self.default_max_goal_rounds,
            &self.writing,
        );
        todo!("heddle-goal: GoalService::get")
    }

    /// Remove this process's continuation authority without changing the phase or the revision.
    pub fn disarm(&self, session: &str) -> Result<Option<GoalView>, GoalError> {
        let _ = session;
        todo!("heddle-goal: GoalService::disarm")
    }

    /// Create and arm a goal. A complete goal may be replaced; anything else is `GOAL_ALREADY_EXISTS`.
    pub fn create(&self, session: &str, request: CreateGoal) -> Result<GoalView, GoalError> {
        let _ = (session, request);
        todo!("heddle-goal: GoalService::create")
    }

    /// Change the objective and/or the cap, keeping the phase; `GOAL_INVALID_EDIT` when the request names neither.
    pub fn edit(
        &self,
        session: &str,
        goal: &GoalRef,
        request: EditGoal,
    ) -> Result<GoalView, GoalError> {
        let _ = (session, goal, request);
        todo!("heddle-goal: GoalService::edit")
    }

    /// Pause an active goal and disarm it.
    pub fn pause(&self, session: &str, goal: &GoalRef) -> Result<GoalView, GoalError> {
        let _ = (session, goal);
        todo!("heddle-goal: GoalService::pause")
    }

    /// Resume a paused, blocked, or active-but-disarmed goal and arm it. Refused when it is active and armed
    /// already, and when its rounds are exhausted (the honest next state is `complete` or a higher cap).
    pub fn resume(&self, session: &str, goal: &GoalRef) -> Result<GoalView, GoalError> {
        let _ = (session, goal);
        todo!("heddle-goal: GoalService::resume")
    }

    /// Mark a non-complete goal complete and disarm it.
    pub fn complete(&self, session: &str, goal: &GoalRef) -> Result<GoalView, GoalError> {
        let _ = (session, goal);
        todo!("heddle-goal: GoalService::complete")
    }

    /// Mark an **active** goal blocked with `reason` — raw, as a tool or a request body carries it, validated
    /// after the reference and the transition (`{code: lower-kebab-case, message: 1..2000}`) — and disarm it.
    pub fn block(
        &self,
        session: &str,
        goal: &GoalRef,
        reason: &Value,
    ) -> Result<GoalView, GoalError> {
        let _ = (session, goal, reason);
        todo!("heddle-goal: GoalService::block")
    }

    /// Clear the current goal, writing a tombstone one revision past it; returns the tombstone's reference.
    pub fn clear(&self, session: &str, goal: &GoalRef) -> Result<GoalRef, GoalError> {
        let _ = (session, goal);
        todo!("heddle-goal: GoalService::clear")
    }
}
