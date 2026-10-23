//! `heddle-goal` — a persisted goal, the model's verbs for it, the round driver that keeps pushing it across
//! rounds and restarts, and the routes the goal bar drives it through.
//!
//! Ported from the TypeScript build: `src/goal/service.ts`, `src/goal/tool.ts`, `src/goal/driver.ts`,
//! `src/plugins/goal-tool.ts`, `src/plugins/goal-driver.ts`, the `/api/goal` branches of `src/server/web.ts`
//! and the `heddle goal` command of `src/cli.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`) by
//! `_verifiers_/80-web-ui` (`check-goal`); the unit tests port `test/goal.test.ts` and `test/goal-driver.test.ts`.
//!
//! # The one idea
//!
//! A goal is not a record that is updated; it is an event that is appended. Every mutation writes one
//! `goal/change` event carrying the complete snapshot (or a clear tombstone), the current state is the strict
//! fold of the log, and every mutation is a compare-and-set on [`GoalRef`] `{id, revision}`. Two lifetimes are
//! kept apart: the durable **phase** and the process-local **activation**. By the owner's rule (a divergence
//! from DSH), an `active` goal is **armed** again when a new process folds it, and the server's boot sweep
//! ([`GoalDriver::resume_at_start`]) hands it to the driver, so pushing survives a restart.
//!
//! # Seams
//!
//! - [`SessionLog`] is the port this crate needs from `heddle-session`'s store; it is implemented for
//!   `heddle_session::SessionStore`, so the boot passes the store itself.
//! - [`RoundRunner`] is how a round is run — append the attributed user message and answer it with one turn;
//!   [`round::AgentRoundRunner`] implements it over `heddle-agent`'s real turn, so the boot passes its runtime.
//! - [`DriverTrigger`] turns the session's own events (`session/event` on the bus) into driver requests; the
//!   boot forwards each event's session id and type to it.
//! - [`tool`] and [`http`] are the model's and the person's verbs, as functions the tool registry and the
//!   server mount; [`cli`] renders `heddle goal`.

#![warn(missing_docs)]

pub mod cli;
pub mod command;
mod driver;
pub mod http;
mod log;
pub mod round;
mod service;
mod store;
#[cfg(test)]
mod test_support;
pub mod tool;

pub use driver::{
    DriverOutcome, DriverRun, DriverTrigger, GoalDriver, GoalRoundSource, QUEUE_FAILED_CODE,
    ROUND_LIMIT_CODE, ResumeReport, RoundDecision, RoundRunner, SessionEdge,
    classify_session_event, decide_goal_round, render_goal_round_prompt,
};
pub use log::{Clock, LogError, SessionLog, SystemClock, iso_timestamp};
pub use service::{
    CreateGoal, DEFAULT_MAX_GOAL_ROUNDS, EditGoal, FoldedGoal, GOAL_CHANGE_EVENT,
    GOAL_CHANGE_VERSION, GoalActivation, GoalBlockReason, GoalChange, GoalConfig, GoalError,
    GoalErrorCode, GoalId, GoalIds, GoalOperation, GoalPhase, GoalRef, GoalService, GoalSnapshot,
    GoalView, MAX_BLOCK_MESSAGE_LENGTH, MAX_OBJECTIVE_LENGTH, RandomGoalIds, decode_goal_change,
    fold_goal, goal_change_event,
};
