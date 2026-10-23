//! The round driver: what makes an active goal actually continue.
//!
//! Its contract, from `src/goal/driver.ts`: **a round is a user message the harness wrote**, carrying
//! `source = {kind:"goal", goalId, revision, round}`, which the fold counts as admitted; rounds run **one at a
//! time per session**, a second trigger joining the running chain and requesting one more pass after it; the
//! driver **stops when the goal stops being runnable** and **blocks with `round-limit`** at the cap. It is a
//! level-triggered reconciler — an edge only says "look again", and [`decide_goal_round`], a pure function of
//! the folded goal, decides.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use futures::future::{BoxFuture, Shared};
use serde::{Deserialize, Serialize};

use crate::service::{GoalBlockReason, GoalService, GoalView};

/// The block code used when the round cap is reached — DSH's own.
pub const ROUND_LIMIT_CODE: &str = "round-limit";

/// The block code used when a round cannot be started at all.
pub const QUEUE_FAILED_CODE: &str = "queue-failed";

/// What should happen next for one goal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoundDecision {
    /// Run round `round` with `prompt`.
    Round {
        /// The 1-based round number: rounds started so far, plus one.
        round: u64,
        /// The round's prompt, from [`render_goal_round_prompt`].
        prompt: String,
    },
    /// Block the goal with `reason` — the cap was reached.
    Block {
        /// `{code: "round-limit", message: "Goal reached its configured limit of N rounds."}`.
        reason: GoalBlockReason,
    },
    /// Do nothing: `no-goal`, `phase-<phase>`, or `disarmed`.
    Stop {
        /// Why.
        why: String,
    },
}

/// The prompt one round carries — DSH's text: the objective and `Round: n/max`, then the standing instruction.
pub fn render_goal_round_prompt(objective: &str, max_goal_rounds: u64, round: u64) -> String {
    let _ = (objective, max_goal_rounds, round);
    todo!("heddle-goal: render_goal_round_prompt")
}

/// Decide what the driver does for one read of the goal: stop without a goal, when the phase is not `active`,
/// or when disarmed; block at the cap; otherwise run the next round.
pub fn decide_goal_round(goal: Option<&GoalView>) -> RoundDecision {
    let _ = goal;
    todo!("heddle-goal: decide_goal_round")
}

/// The `source` a round's user message carries. Serialized `{kind:"goal", goalId, revision, round}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalRoundSource {
    /// Always `"goal"`.
    pub kind: String,
    /// The goal the round serves.
    pub goal_id: String,
    /// The revision it was started under.
    pub revision: u64,
    /// Its 1-based number.
    pub round: u64,
}

/// How one round is run: append the attributed user message (with `source`) and answer it with one turn.
///
/// The boot implements it over `heddle-agent`'s turn, with the session's endpoint and model; an error is the
/// turn's failure, reported in the outcome (`turn-failed`) and leaving the goal as it is.
pub trait RoundRunner: Send + Sync + 'static {
    /// Run one round to completion.
    fn run(
        &self,
        session: &str,
        prompt: String,
        source: GoalRoundSource,
    ) -> BoxFuture<'static, Result<(), String>>;
}

/// What one chain did. Serialized `{rounds, stopped, blocked?, error?}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriverOutcome {
    /// Rounds admitted and answered.
    pub rounds: u64,
    /// Why the chain ended: `idle`, `no-goal`, `disarmed`, `phase-complete`, `round-limit`, `goal-moved`,
    /// `cleared`, `round-not-admitted`, `turn-failed`, …
    pub stopped: String,
    /// Present when the chain ended by blocking the goal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<GoalBlockReason>,
    /// Present when a round, or the block, failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A running or settled chain. Awaiting it yields the chain's outcome; the chain runs whether or not anyone
/// awaits it (it is a spawned task), and every request that joined it awaits the same outcome.
#[derive(Clone)]
pub struct DriverRun {
    shared: Shared<BoxFuture<'static, DriverOutcome>>,
}

impl Future for DriverRun {
    type Output = DriverOutcome;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<DriverOutcome> {
        Pin::new(&mut self.shared).poll(cx)
    }
}

/// What the boot sweep did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumeReport {
    /// Sessions whose goal was runnable and handed to the driver.
    pub requested: u64,
}

/// One session's lane: whether another pass was requested, and the chain draining it.
#[expect(
    dead_code,
    reason = "read by the driver's implementation, which follows the API"
)]
struct Lane {
    requested: bool,
    run: Option<DriverRun>,
}

/// The driver: one serialized chain per session.
pub struct GoalDriver {
    goals: Arc<GoalService>,
    runner: Arc<dyn RoundRunner>,
    lanes: Mutex<HashMap<String, Lane>>,
}

impl GoalDriver {
    /// A driver over `goals`, running rounds with `runner`.
    pub fn new(goals: Arc<GoalService>, runner: Arc<dyn RoundRunner>) -> Arc<GoalDriver> {
        Arc::new(GoalDriver {
            goals,
            runner,
            lanes: Mutex::new(HashMap::new()),
        })
    }

    /// Ask the driver to re-evaluate `session`. Idempotent and reentrant: while a chain runs, this joins it and
    /// requests one more pass after it, so an edge that lands mid-chain is never lost; otherwise it spawns a
    /// new chain. Must be called inside a Tokio runtime.
    pub fn request(self: &Arc<Self>, session: &str) -> DriverRun {
        let _ = (session, &self.goals, &self.runner, &self.lanes);
        todo!("heddle-goal: GoalDriver::request")
    }

    /// The command line's join after a one-shot turn: the same as [`request`](GoalDriver::request).
    pub fn advance(self: &Arc<Self>, session: &str) -> DriverRun {
        self.request(session)
    }

    /// The server's boot sweep: request every session in `sessions` whose goal is runnable now (an `active`
    /// goal is armed in a new process), without waiting for the chains. A one-shot command does not call it.
    pub fn resume_at_start(self: &Arc<Self>, sessions: &[String]) -> ResumeReport {
        let _ = sessions;
        todo!("heddle-goal: GoalDriver::resume_at_start")
    }
}

/// How a session event bears on the driver.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionEdge {
    /// `turn/completed`: the session is idle — request a pass.
    TurnCompleted,
    /// `model/request`, `assistant/chunk`, `turn/retry`, `tool/result`: a turn is in flight.
    TurnActivity,
    /// `goal/change`: request a pass if the session is at rest; a running turn's completion re-evaluates.
    GoalChange,
    /// Anything else.
    Other,
}

/// Classify a session event by its `type`.
pub fn classify_session_event(event_type: &str) -> SessionEdge {
    let _ = event_type;
    todo!("heddle-goal: classify_session_event")
}

/// The goal-driver plugin's trigger (`src/plugins/goal-driver.ts`): it follows each session's events, knows
/// which sessions are inside a turn, and requests the driver on the edges that may make a round due. The boot
/// forwards every `session/event` to [`on_session_event`](DriverTrigger::on_session_event).
pub struct DriverTrigger {
    driver: Arc<GoalDriver>,
    in_turn: Mutex<HashSet<String>>,
}

impl DriverTrigger {
    /// A trigger for `driver`.
    pub fn new(driver: Arc<GoalDriver>) -> DriverTrigger {
        DriverTrigger {
            driver,
            in_turn: Mutex::new(HashSet::new()),
        }
    }

    /// One appended event of `session`: returns the chain it requested, if it requested one. Never blocks; the
    /// chain is not awaited, so a turn is not held open by the rounds it starts.
    pub fn on_session_event(&self, session: &str, event_type: &str) -> Option<DriverRun> {
        let _ = (session, event_type, &self.driver, &self.in_turn);
        todo!("heddle-goal: DriverTrigger::on_session_event")
    }
}
