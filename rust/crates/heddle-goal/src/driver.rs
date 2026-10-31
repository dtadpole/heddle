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

use futures::future::{BoxFuture, FutureExt, Shared};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::service::{GoalBlockReason, GoalPhase, GoalRef, GoalService, GoalView};

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
    let quoted = serde_json::to_string(objective).expect("a string is plain data");
    format!(
        "Objective: {quoted}\n\
         Round: {round}/{max_goal_rounds}\n\
         \n\
         Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker."
    )
}

/// Decide what the driver does for one read of the goal: stop without a goal, when the phase is not `active`,
/// or when disarmed; block at the cap; otherwise run the next round.
pub fn decide_goal_round(goal: Option<&GoalView>) -> RoundDecision {
    let Some(goal) = goal else {
        return RoundDecision::Stop {
            why: "no-goal".to_owned(),
        };
    };
    if goal.goal.phase != GoalPhase::Active {
        return RoundDecision::Stop {
            why: format!("phase-{}", goal.goal.phase.as_str()),
        };
    }
    if goal.activation != crate::service::GoalActivation::Armed {
        return RoundDecision::Stop {
            why: "disarmed".to_owned(),
        };
    }
    if goal.rounds_started >= goal.goal.max_goal_rounds {
        return RoundDecision::Block {
            reason: GoalBlockReason {
                code: ROUND_LIMIT_CODE.to_owned(),
                message: format!(
                    "Goal reached its configured limit of {} rounds.",
                    goal.goal.max_goal_rounds
                ),
            },
        };
    }
    let round = goal.rounds_started + 1;
    RoundDecision::Round {
        round,
        prompt: render_goal_round_prompt(&goal.goal.objective, goal.goal.max_goal_rounds, round),
    }
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
    /// `cleared`, `round-not-admitted`, `turn-failed`, `no-runtime`, …
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
struct Lane {
    requested: bool,
    run: Option<DriverRun>,
}

/// The driver: one serialized chain per session.
pub struct GoalDriver {
    goals: Arc<GoalService>,
    runner: Arc<dyn RoundRunner>,
    lanes: Mutex<HashMap<String, Lane>>,
    /// Where chains run when the caller is not inside a runtime: a session event can be appended, and so
    /// reach the trigger, on any thread.
    runtime: Option<tokio::runtime::Handle>,
}

/// The sentence a request answers with when the driver has no runtime to run its chain on.
pub const NO_RUNTIME_SENTENCE: &str =
    "the goal driver has no async runtime to run on; build it with GoalDriver::with_runtime";

impl GoalDriver {
    /// A driver over `goals`, running rounds with `runner`, on the runtime current when it is built (if any).
    pub fn new(goals: Arc<GoalService>, runner: Arc<dyn RoundRunner>) -> Arc<GoalDriver> {
        Arc::new(GoalDriver {
            goals,
            runner,
            lanes: Mutex::new(HashMap::new()),
            runtime: tokio::runtime::Handle::try_current().ok(),
        })
    }

    /// A driver whose chains run on `runtime`, whichever thread requests them — what the boot builds, since a
    /// session event reaches the trigger on the thread that appended it.
    pub fn with_runtime(
        goals: Arc<GoalService>,
        runner: Arc<dyn RoundRunner>,
        runtime: tokio::runtime::Handle,
    ) -> Arc<GoalDriver> {
        Arc::new(GoalDriver {
            goals,
            runner,
            lanes: Mutex::new(HashMap::new()),
            runtime: Some(runtime),
        })
    }

    /// The runtime a chain is spawned on: the driver's own, else the caller's.
    fn spawner(&self) -> Option<tokio::runtime::Handle> {
        self.runtime
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
    }

    /// Ask the driver to re-evaluate `session`. Idempotent and reentrant: while a chain runs, this joins it and
    /// requests one more pass after it, so an edge that lands mid-chain is never lost; otherwise it spawns a
    /// new chain on the driver's runtime (the caller's when it has none). With no runtime at all the run
    /// resolves at once to an error outcome naming the cause, rather than panicking in whatever thread asked.
    pub fn request(self: &Arc<Self>, session: &str) -> DriverRun {
        let Some(runtime) = self.spawner() else {
            tracing::warn!(session, "{NO_RUNTIME_SENTENCE}");
            let outcome = DriverOutcome {
                rounds: 0,
                stopped: "no-runtime".to_owned(),
                blocked: None,
                error: Some(NO_RUNTIME_SENTENCE.to_owned()),
            };
            let future: BoxFuture<'static, DriverOutcome> = Box::pin(async move { outcome });
            return DriverRun {
                shared: future.shared(),
            };
        };
        let mut lanes = self
            .lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lane = lanes.entry(session.to_owned()).or_insert_with(|| Lane {
            requested: false,
            run: None,
        });
        lane.requested = true;
        if let Some(run) = &lane.run {
            return run.clone();
        }
        // Store the chain on the lane **before** it starts: a round that requests another pass from
        // inside itself then sees the lane busy and only sets the flag, instead of starting a second chain.
        let (sender, receiver) = futures::channel::oneshot::channel::<DriverOutcome>();
        let future: BoxFuture<'static, DriverOutcome> = Box::pin(async move {
            receiver.await.unwrap_or_else(|_| DriverOutcome {
                rounds: 0,
                stopped: "cancelled".to_owned(),
                blocked: None,
                error: Some("the driver chain was cancelled".to_owned()),
            })
        });
        let run = DriverRun {
            shared: future.shared(),
        };
        lane.run = Some(run.clone());
        drop(lanes);
        let driver = Arc::clone(self);
        let session = session.to_owned();
        runtime.spawn(async move {
            let outcome = driver.drain(&session).await;
            driver.finish(&session);
            let _ = sender.send(outcome);
        });
        run
    }

    /// The command line's join after a one-shot turn: the same as [`request`](GoalDriver::request).
    pub fn advance(self: &Arc<Self>, session: &str) -> DriverRun {
        self.request(session)
    }

    /// The server's boot sweep: request every session in `sessions` whose goal is runnable now (an `active`
    /// goal is armed in a new process), without waiting for the chains. A one-shot command does not call it.
    pub fn resume_at_start(self: &Arc<Self>, sessions: &[String]) -> ResumeReport {
        let mut requested = 0;
        for session in sessions {
            let Ok(Some(view)) = self.goals.get(session) else {
                continue;
            };
            if !matches!(decide_goal_round(Some(&view)), RoundDecision::Round { .. }) {
                continue;
            }
            requested += 1;
            drop(self.request(session));
        }
        ResumeReport { requested }
    }

    /// One chain: every pass the lane asked for, then settle.
    async fn drain(&self, session: &str) -> DriverOutcome {
        let mut rounds = 0u64;
        let mut stopped = "idle".to_owned();
        let mut blocked: Option<GoalBlockReason> = None;
        let mut error: Option<String> = None;
        loop {
            let requested = {
                let mut lanes = self
                    .lanes
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match lanes.get_mut(session) {
                    Some(lane) => {
                        let requested = lane.requested;
                        lane.requested = false;
                        requested
                    }
                    None => false,
                }
            };
            if !requested {
                break;
            }
            let outcome = self.reconcile(session).await;
            rounds += outcome.rounds;
            stopped = outcome.stopped;
            if outcome.blocked.is_some() {
                blocked = outcome.blocked;
            }
            if outcome.error.is_some() {
                error = outcome.error;
            }
        }
        DriverOutcome {
            rounds,
            stopped,
            blocked,
            error,
        }
    }

    /// One evaluation of the condition: act on it until it stops being runnable.
    async fn reconcile(&self, session: &str) -> DriverOutcome {
        let mut rounds = 0u64;
        loop {
            let view = match self.goals.get(session) {
                Ok(view) => view,
                Err(error) => {
                    return DriverOutcome {
                        rounds,
                        stopped: "goal-read-failed".to_owned(),
                        blocked: None,
                        error: Some(error.to_string()),
                    };
                }
            };
            match decide_goal_round(view.as_ref()) {
                RoundDecision::Stop { why } => {
                    return DriverOutcome {
                        rounds,
                        stopped: why,
                        blocked: None,
                        error: None,
                    };
                }
                RoundDecision::Block { reason } => {
                    let Some(view) = view else {
                        unreachable!("a block decision needs a goal");
                    };
                    let reference = GoalRef {
                        id: view.goal.id.clone(),
                        revision: view.goal.revision,
                    };
                    let outcome = self.goals.block(
                        session,
                        &reference,
                        &json!({ "code": reason.code, "message": reason.message }),
                    );
                    return DriverOutcome {
                        rounds,
                        stopped: "round-limit".to_owned(),
                        blocked: Some(reason),
                        error: outcome.err().map(|error| error.to_string()),
                    };
                }
                RoundDecision::Round { round, prompt } => {
                    let Some(view) = view else {
                        unreachable!("a round decision needs a goal");
                    };
                    let goal_id = view.goal.id.clone();
                    let revision = view.goal.revision;
                    let before = view.rounds_started;
                    let source = GoalRoundSource {
                        kind: "goal".to_owned(),
                        goal_id: goal_id.clone(),
                        revision,
                        round,
                    };
                    if let Err(error) = self.runner.run(session, prompt, source).await {
                        return DriverOutcome {
                            rounds,
                            stopped: "turn-failed".to_owned(),
                            blocked: None,
                            error: Some(error),
                        };
                    }
                    // Yield between rounds so a person's pause, or an HTTP request, gets a turn.
                    tokio::task::yield_now().await;
                    let after = match self.goals.get(session) {
                        Ok(after) => after,
                        Err(error) => {
                            return DriverOutcome {
                                rounds,
                                stopped: "goal-read-failed".to_owned(),
                                blocked: None,
                                error: Some(error.to_string()),
                            };
                        }
                    };
                    let Some(after) = after else {
                        return DriverOutcome {
                            rounds: rounds + 1,
                            stopped: "cleared".to_owned(),
                            blocked: None,
                            error: None,
                        };
                    };
                    if after.rounds_started <= before {
                        return DriverOutcome {
                            rounds: rounds + 1,
                            stopped: "round-not-admitted".to_owned(),
                            blocked: None,
                            error: None,
                        };
                    }
                    rounds += 1;
                    if after.goal.id != goal_id || after.goal.revision != revision {
                        return DriverOutcome {
                            rounds,
                            stopped: "goal-moved".to_owned(),
                            blocked: None,
                            error: None,
                        };
                    }
                }
            }
        }
    }

    /// Clear a settled lane, draining an edge that arrived as it settled.
    fn finish(self: &Arc<Self>, session: &str) {
        let pending = {
            let mut lanes = self
                .lanes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match lanes.get_mut(session) {
                Some(lane) => {
                    lane.run = None;
                    lane.requested
                }
                None => false,
            }
        };
        if pending && let Some(runtime) = self.spawner() {
            let driver = Arc::clone(self);
            let session = session.to_owned();
            runtime.spawn(async move {
                let run = driver.request(&session);
                let _ = run.await;
            });
        }
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
    match event_type {
        "turn/completed" => SessionEdge::TurnCompleted,
        "model/request" | "assistant/chunk" | "turn/retry" | "tool/result" => {
            SessionEdge::TurnActivity
        }
        "goal/change" => SessionEdge::GoalChange,
        _ => SessionEdge::Other,
    }
}

/// The goal-driver plugin's trigger (`src/plugins/goal-driver.ts`): it follows each session's events, knows
/// which sessions are inside a turn, and requests the driver on the edges that may make a round due. The boot
/// forwards every `session/event` to [`on_session_event`](DriverTrigger::on_session_event).
pub struct DriverTrigger {
    driver: Arc<GoalDriver>,
    in_turn: Mutex<HashSet<String>>,
}

/// Whether a `turn/completed` event says its turn ended abnormally: stopped, or failed with an error. Every
/// failed or stopped turn writes one since d9443684 (`record_unfinished`).
pub fn turn_ended_abnormally(event: &serde_json::Value) -> bool {
    event.get("stopped") == Some(&serde_json::Value::Bool(true)) || event.get("error").is_some()
}

impl DriverTrigger {
    /// A trigger for `driver`.
    pub fn new(driver: Arc<GoalDriver>) -> DriverTrigger {
        DriverTrigger {
            driver,
            in_turn: Mutex::new(HashSet::new()),
        }
    }

    /// One appended event of `session` (the event object, with its `type`): returns the chain it requested, if
    /// it requested one. Never blocks; the chain is not awaited, so a turn is not held open by the rounds it
    /// starts.
    ///
    /// A turn that ended abnormally is no edge (DSH's dsh-goal-round-driver: "Cancellation never auto-restarts a
    /// round"; "No abnormal auto-retry"): a `turn/completed` that is stopped or names an error
    /// ([`turn_ended_abnormally`]). Without this, a failing provider chained goal rounds up to the cap: the chain
    /// stops on a failed round, and the failed turn's completion started a new chain. The goal stays as it is; a
    /// person's next turn or a goal change may continue it. `goal-driver.ts` does the same.
    pub fn on_session_event(&self, session: &str, event: &serde_json::Value) -> Option<DriverRun> {
        let event_type = event
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        match classify_session_event(event_type) {
            SessionEdge::TurnCompleted => {
                self.in_turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(session);
                if turn_ended_abnormally(event) {
                    return None;
                }
                self.request_if_known(session)
            }
            SessionEdge::TurnActivity => {
                self.in_turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(session.to_owned());
                None
            }
            SessionEdge::GoalChange => {
                let busy = self
                    .in_turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .contains(session);
                if busy {
                    // The running turn's completion re-evaluates the condition.
                    None
                } else {
                    self.request_if_known(session)
                }
            }
            SessionEdge::Other => None,
        }
    }

    /// Request a pass for a session that exists; a trigger for an unknown id is a no-op.
    fn request_if_known(&self, session: &str) -> Option<DriverRun> {
        self.driver.goals.log().open(session)?;
        Some(self.driver.request(session))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::service::{CreateGoal, GoalActivation, GoalService, GoalSnapshot, fold_goal};
    use crate::test_support::{MemoryLog, fixture};

    type Hook = Arc<dyn Fn(&str, u64) + Send + Sync>;

    struct TestRunner {
        log: Arc<MemoryLog>,
        calls: Arc<Mutex<Vec<(u64, String)>>>,
        hook: Option<Hook>,
        fail: bool,
        record: bool,
    }

    impl RoundRunner for TestRunner {
        fn run(
            &self,
            session: &str,
            prompt: String,
            source: GoalRoundSource,
        ) -> BoxFuture<'static, Result<(), String>> {
            self.calls
                .lock()
                .unwrap()
                .push((source.round, prompt.clone()));
            if self.fail {
                return Box::pin(async { Err("provider down".to_owned()) });
            }
            if self.record {
                self.log.append_raw(
                    session,
                    json!({
                        "type": "message",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": prompt}],
                            "source": source
                        }
                    }),
                );
            }
            if let Some(hook) = &self.hook {
                hook(session, source.round);
            }
            Box::pin(async { Ok(()) })
        }
    }

    fn runner(log: &Arc<MemoryLog>, calls: &Arc<Mutex<Vec<(u64, String)>>>) -> TestRunner {
        TestRunner {
            log: log.clone(),
            calls: calls.clone(),
            hook: None,
            fail: false,
            record: true,
        }
    }

    fn setup() -> (Arc<MemoryLog>, Arc<GoalService>) {
        let (log, service) = fixture("s1");
        (log, Arc::new(service))
    }

    fn create(goals: &GoalService, max_goal_rounds: f64) -> GoalView {
        goals
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: Some(max_goal_rounds),
                },
            )
            .unwrap()
    }

    fn view() -> GoalView {
        GoalView {
            goal: GoalSnapshot {
                id: "goal-1".into(),
                revision: 1,
                objective: "ship the driver".into(),
                phase: GoalPhase::Active,
                max_goal_rounds: 4,
                blocked_reason: None,
            },
            rounds_started: 0,
            created_at: "2026-10-17T00:00:00.000Z".into(),
            updated_at: "2026-10-17T00:00:00.000Z".into(),
            activation: GoalActivation::Armed,
        }
    }

    #[test]
    fn the_continuation_prompt_restates_the_objective_and_the_round() {
        let prompt = render_goal_round_prompt("ship \"it\"", 4, 3);
        assert!(
            prompt.starts_with("Objective: \"ship \\\"it\\\"\"\nRound: 3/4\n"),
            "saw: {prompt}"
        );
        assert!(prompt.contains("Continue working toward the objective in this same session"));
        assert!(prompt.contains("leave the goal active for the next round"));
    }

    #[test]
    fn the_decision_refuses_every_non_runnable_goal_and_blocks_at_the_cap() {
        assert_eq!(
            decide_goal_round(None),
            RoundDecision::Stop {
                why: "no-goal".to_owned()
            }
        );
        for phase in [GoalPhase::Paused, GoalPhase::Blocked, GoalPhase::Complete] {
            let mut goal = view();
            goal.goal.phase = phase;
            assert_eq!(
                decide_goal_round(Some(&goal)),
                RoundDecision::Stop {
                    why: format!("phase-{}", phase.as_str())
                }
            );
        }
        let mut disarmed = view();
        disarmed.activation = GoalActivation::Disarmed;
        assert_eq!(
            decide_goal_round(Some(&disarmed)),
            RoundDecision::Stop {
                why: "disarmed".to_owned()
            }
        );

        let mut running = view();
        running.rounds_started = 2;
        match decide_goal_round(Some(&running)) {
            RoundDecision::Round { round, prompt } => {
                assert_eq!(round, 3);
                assert!(prompt.contains("Round: 3/4"));
            }
            other => panic!("expected a round, got {other:?}"),
        }

        let mut capped = view();
        capped.rounds_started = 4;
        match decide_goal_round(Some(&capped)) {
            RoundDecision::Block { reason } => {
                assert_eq!(reason.code, ROUND_LIMIT_CODE);
                assert!(reason.message.contains("limit of 4 rounds"));
            }
            other => panic!("expected a block, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_chain_runs_one_round_at_a_time_and_the_fold_counts_each_admitted_round() {
        let (log, goals) = setup();
        let created = create(&goals, 3.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let outcome = driver.advance("s1").await;
        assert_eq!(outcome.rounds, 3);
        assert_eq!(outcome.stopped, "round-limit");
        assert_eq!(outcome.blocked.as_ref().unwrap().code, ROUND_LIMIT_CODE);
        let rounds: Vec<u64> = calls
            .lock()
            .unwrap()
            .iter()
            .map(|(round, _)| *round)
            .collect();
        assert_eq!(
            rounds,
            [1, 2, 3],
            "each round number is used once, in order"
        );
        assert!(calls.lock().unwrap()[0].1.contains("Round: 1/3"));

        let folded = fold_goal(&log.events("s1")).unwrap();
        assert_eq!(folded.rounds_started, 3);
        assert_eq!(folded.goal.as_ref().unwrap().phase, GoalPhase::Blocked);
        assert_eq!(
            folded
                .goal
                .as_ref()
                .unwrap()
                .blocked_reason
                .as_ref()
                .unwrap()
                .message,
            "Goal reached its configured limit of 3 rounds."
        );
        assert_eq!(folded.goal.as_ref().unwrap().id, created.goal.id);
    }

    #[tokio::test]
    async fn a_chain_stops_when_the_goal_is_not_runnable() {
        let (log, goals) = setup();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        assert_eq!(driver.advance("s1").await.stopped, "no-goal");

        let created = create(&goals, 4.0);
        goals
            .pause(
                "s1",
                &GoalRef {
                    id: created.goal.id,
                    revision: created.goal.revision,
                },
            )
            .unwrap();
        assert_eq!(driver.advance("s1").await.stopped, "phase-paused");
        assert!(
            calls.lock().unwrap().is_empty(),
            "a paused goal runs no round"
        );
    }

    #[tokio::test]
    async fn an_active_goal_continues_in_a_reopened_process() {
        let (log, goals) = setup();
        let created = create(&goals, 2.0);
        let reopened = Arc::new(GoalService::new(
            log.clone(),
            crate::service::GoalConfig::default(),
        ));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(reopened.clone(), Arc::new(runner(&log, &calls)));
        let outcome = driver.advance("s1").await;
        assert_eq!(outcome.rounds, 2, "the reopened process ran the rounds");
        assert_eq!(outcome.stopped, "round-limit");
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(
            reopened.get("s1").unwrap().unwrap().goal.id,
            created.goal.id
        );
    }

    #[tokio::test]
    async fn the_boot_sweep_requests_exactly_the_runnable_goals() {
        let (log, goals) = setup();
        create(&goals, 4.0);
        log.create("s2");
        let paused = goals
            .create(
                "s2",
                CreateGoal {
                    objective: "paused".into(),
                    max_goal_rounds: Some(4.0),
                },
            )
            .unwrap();
        goals
            .pause(
                "s2",
                &GoalRef {
                    id: paused.goal.id,
                    revision: paused.goal.revision,
                },
            )
            .unwrap();
        log.create("s3");

        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let report = driver.resume_at_start(&["s1".to_owned(), "s2".to_owned(), "s3".to_owned()]);
        assert_eq!(report.requested, 1);
        // Join the fire-and-forget chain the sweep started.
        let outcome = driver.advance("s1").await;
        assert!(!calls.lock().unwrap().is_empty());
        assert!(
            outcome.stopped == "round-limit" || outcome.stopped == "phase-blocked",
            "saw {}",
            outcome.stopped
        );
    }

    #[tokio::test]
    async fn a_round_yields_so_a_pause_scheduled_during_it_takes_effect() {
        let (log, goals) = setup();
        let created = create(&goals, 100.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let pause_goals = goals.clone();
        let reference = GoalRef {
            id: created.goal.id.clone(),
            revision: created.goal.revision,
        };
        let slot: Arc<OnceLock<Arc<GoalDriver>>> = Arc::new(OnceLock::new());
        let slot_in_hook = slot.clone();
        let hook: Hook = Arc::new(move |session: &str, round: u64| {
            if round == 1 {
                let goals = pause_goals.clone();
                let reference = reference.clone();
                let session = session.to_owned();
                let slot = slot_in_hook.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::ZERO).await;
                    let _ = goals.pause(&session, &reference);
                    // The pause's own edge asks the driver to look again, as the plugin's trigger does.
                    if let Some(driver) = slot.get() {
                        drop(driver.request(&session));
                    }
                });
            }
        });
        let mut runner = runner(&log, &calls);
        runner.hook = Some(hook);
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner));
        slot.set(driver.clone()).ok();
        let outcome = driver.advance("s1").await;
        assert_eq!(
            goals.get("s1").unwrap().unwrap().goal.phase,
            GoalPhase::Paused,
            "the pause landed while the goal was running"
        );
        assert!(
            calls.lock().unwrap().len() < 100,
            "the yield let the pause land before the cap (ran {})",
            calls.lock().unwrap().len()
        );
        assert_eq!(outcome.stopped, "phase-paused");
    }

    #[tokio::test]
    async fn a_round_that_was_not_admitted_stops_the_chain() {
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut runner = runner(&log, &calls);
        runner.record = false;
        let driver = GoalDriver::new(goals, Arc::new(runner));
        let outcome = driver.advance("s1").await;
        assert_eq!(calls.lock().unwrap().len(), 1, "the broken round ran once");
        assert_eq!(outcome.stopped, "round-not-admitted");
    }

    #[tokio::test]
    async fn a_goal_moved_during_its_round_stops_the_chain() {
        let (log, goals) = setup();
        let created = create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let edit_goals = goals.clone();
        let reference = GoalRef {
            id: created.goal.id.clone(),
            revision: created.goal.revision,
        };
        let hook: Hook = Arc::new(move |session: &str, _round: u64| {
            let _ = edit_goals.edit(
                session,
                &reference,
                crate::service::EditGoal {
                    objective: Some("a better objective".into()),
                    max_goal_rounds: None,
                },
            );
        });
        let mut runner = runner(&log, &calls);
        runner.hook = Some(hook);
        let driver = GoalDriver::new(goals, Arc::new(runner));
        let outcome = driver.advance("s1").await;
        assert_eq!(outcome.rounds, 1);
        assert_eq!(outcome.stopped, "goal-moved");
    }

    /// R-developer-two-31: an edit during a round must not let the goal run past its cap. DSH's fold counts rounds
    /// across revisions, so a cap of three allows three rounds in total. Measured before the fix on both builds: an
    /// edit during round 2 gave five rounds, labelled 1/3, 2/3, 3/3, 3/3, 3/3.
    #[tokio::test]
    async fn an_edit_during_a_round_does_not_let_the_goal_run_past_its_cap() {
        let (log, goals) = setup();
        create(&goals, 3.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let edit_goals = goals.clone();
        let hook: Hook = Arc::new(move |session: &str, round: u64| {
            if round != 2 {
                return;
            }
            // The person edits the objective while round 2 runs, as in the parity measurement.
            let current = edit_goals.get(session).unwrap().unwrap();
            edit_goals
                .edit(
                    session,
                    &current.goal.goal_ref(),
                    crate::service::EditGoal {
                        objective: Some("three rounds at most, sharper".into()),
                        max_goal_rounds: None,
                    },
                )
                .unwrap();
        });
        let mut runner = runner(&log, &calls);
        runner.hook = Some(hook);
        let driver = GoalDriver::new(goals, Arc::new(runner));

        // The edit stops the first chain; the next trigger starts another, as a turn/completed would.
        assert_eq!(driver.advance("s1").await.stopped, "goal-moved");
        assert_eq!(driver.advance("s1").await.stopped, "round-limit");

        let calls = calls.lock().unwrap();
        let rounds: Vec<u64> = calls.iter().map(|(round, _)| *round).collect();
        assert_eq!(rounds, [1, 2, 3], "three rounds in total, each number once");
        let labels: Vec<&str> = calls
            .iter()
            .map(|(_, prompt)| prompt.lines().nth(1).unwrap_or(""))
            .collect();
        assert_eq!(labels, ["Round: 1/3", "Round: 2/3", "Round: 3/3"]);
        let folded = fold_goal(&log.events("s1")).unwrap();
        assert_eq!(folded.rounds_started, 3);
        let goal = folded.goal.unwrap();
        assert_eq!(goal.phase, GoalPhase::Blocked);
        assert_eq!(goal.revision, 3, "create, edit, then the round-limit block");
    }

    #[test]
    fn a_log_written_before_the_fix_still_folds_and_its_repeated_round_numbers_count_once() {
        let (log, goals) = setup();
        let created = create(&goals, 3.0);
        let say = |revision: u64, round: u64| {
            log.append_raw(
                "s1",
                json!({
                    "type": "message",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": format!("Round: {round}/3")}],
                        "source": {"kind": "goal", "goalId": created.goal.id.as_str(), "revision": revision, "round": round}
                    }
                }),
            );
        };
        say(1, 1);
        say(1, 2);
        goals
            .edit(
                "s1",
                &created.goal.goal_ref(),
                crate::service::EditGoal {
                    objective: Some("old log, edited".into()),
                    max_goal_rounds: None,
                },
            )
            .unwrap();
        // What the old driver wrote after an edit: round 3 three times under the new revision.
        say(2, 3);
        say(2, 3);
        say(2, 3);
        let folded = fold_goal(&log.events("s1")).unwrap();
        assert_eq!(
            folded.rounds_started, 3,
            "the duplicates are not extra rounds, and replay does not fail"
        );
        let view = goals.get("s1").unwrap().unwrap();
        assert!(matches!(
            decide_goal_round(Some(&view)),
            RoundDecision::Block { .. }
        ));
    }

    #[tokio::test]
    async fn a_goal_completed_during_its_round_stops_the_chain() {
        let (log, goals) = setup();
        let created = create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let complete_goals = goals.clone();
        let reference = GoalRef {
            id: created.goal.id.clone(),
            revision: created.goal.revision,
        };
        let hook: Hook = Arc::new(move |session: &str, _round: u64| {
            let _ = complete_goals.complete(session, &reference);
        });
        let mut runner = runner(&log, &calls);
        runner.hook = Some(hook);
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner));
        let outcome = driver.advance("s1").await;
        assert_eq!(outcome.stopped, "goal-moved");
        assert_eq!(
            goals.get("s1").unwrap().unwrap().goal.phase,
            GoalPhase::Complete
        );
    }

    #[tokio::test]
    async fn a_second_trigger_joins_the_running_chain() {
        let (log, goals) = setup();
        create(&goals, 2.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals, Arc::new(runner(&log, &calls)));
        let first = driver.advance("s1");
        let second = driver.advance("s1");
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first, second, "both callers saw the same chain");
        let rounds: Vec<u64> = calls
            .lock()
            .unwrap()
            .iter()
            .map(|(round, _)| *round)
            .collect();
        assert_eq!(rounds, [1, 2], "and it ran each round once");
    }

    #[tokio::test]
    async fn a_turn_that_throws_leaves_the_goal_runnable() {
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut runner = runner(&log, &calls);
        runner.fail = true;
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner));
        let outcome = driver.advance("s1").await;
        assert_eq!(outcome.stopped, "turn-failed");
        assert_eq!(outcome.error.as_deref(), Some("provider down"));
        let view = goals.get("s1").unwrap().unwrap();
        assert_eq!(view.goal.phase, GoalPhase::Active);
        assert_eq!(view.activation, GoalActivation::Armed);
    }

    #[tokio::test]
    async fn an_edge_that_arrives_during_a_chain_is_re_evaluated() {
        let (log, goals) = setup();
        let created = create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let slot: Arc<OnceLock<Arc<GoalDriver>>> = Arc::new(OnceLock::new());
        let complete_goals = goals.clone();
        let reference = GoalRef {
            id: created.goal.id.clone(),
            revision: created.goal.revision,
        };
        let slot_in_hook = slot.clone();
        let hook: Hook = Arc::new(move |session: &str, _round: u64| {
            let _ = complete_goals.complete(session, &reference);
            if let Some(driver) = slot_in_hook.get() {
                drop(driver.request(session));
            }
        });
        let mut runner = runner(&log, &calls);
        runner.hook = Some(hook);
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner));
        slot.set(driver.clone()).ok();
        let outcome = driver.request("s1").await;
        assert_eq!(calls.lock().unwrap().len(), 1, "no extra round ran");
        assert_eq!(
            outcome.stopped, "phase-complete",
            "the pass re-evaluated the edge that arrived during the round"
        );
        assert_eq!(
            goals.get("s1").unwrap().unwrap().goal.phase,
            GoalPhase::Complete
        );
    }

    #[tokio::test]
    async fn requesting_an_idle_session_with_a_paused_goal_settles_without_a_round() {
        let (log, goals) = setup();
        let created = create(&goals, 4.0);
        goals
            .pause(
                "s1",
                &GoalRef {
                    id: created.goal.id,
                    revision: created.goal.revision,
                },
            )
            .unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let outcome = driver.request("s1").await;
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(outcome.stopped, "phase-paused");
    }

    #[test]
    fn a_session_event_is_classified_by_its_type() {
        assert_eq!(
            classify_session_event("turn/completed"),
            SessionEdge::TurnCompleted
        );
        for activity in [
            "model/request",
            "assistant/chunk",
            "turn/retry",
            "tool/result",
        ] {
            assert_eq!(classify_session_event(activity), SessionEdge::TurnActivity);
        }
        assert_eq!(
            classify_session_event("goal/change"),
            SessionEdge::GoalChange
        );
        assert_eq!(classify_session_event("message"), SessionEdge::Other);
    }

    #[tokio::test]
    async fn the_trigger_requests_on_completion_and_ignores_a_goal_change_inside_a_turn() {
        let (log, goals) = setup();
        let created = create(&goals, 4.0);
        let reference = GoalRef {
            id: created.goal.id.clone(),
            revision: created.goal.revision,
        };
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let trigger = DriverTrigger::new(driver.clone());

        assert!(
            trigger
                .on_session_event("s1", &json!({ "type": "model/request" }))
                .is_none()
        );
        assert!(
            trigger
                .on_session_event("s1", &json!({ "type": "goal/change" }))
                .is_none(),
            "a goal change inside a turn waits for the completion edge"
        );
        let run = trigger.on_session_event("s1", &json!({ "type": "turn/completed" }));
        assert!(run.is_some(), "a completion requests a pass");
        let _ = run.unwrap().await;
        assert!(!calls.lock().unwrap().is_empty());

        // At rest, a goal change requests a pass of its own.
        let _ = goals.edit(
            "s1",
            &GoalRef {
                id: reference.id.clone(),
                revision: goals.get("s1").unwrap().unwrap().goal.revision,
            },
            crate::service::EditGoal {
                objective: Some("edited".into()),
                max_goal_rounds: None,
            },
        );
        assert!(
            trigger
                .on_session_event("s1", &json!({ "type": "goal/change" }))
                .is_some()
        );
        assert!(
            trigger
                .on_session_event("nope", &json!({ "type": "turn/completed" }))
                .is_none(),
            "an unknown session is a no-op"
        );
    }

    #[tokio::test]
    async fn a_stopped_or_failed_turn_requests_no_pass() {
        // DSH's dsh-goal-round-driver never auto-restarts a cancelled round and never auto-retries an abnormal
        // failure. Since d9443684 every failed or stopped turn writes turn/completed with `stopped` or `error`.
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let trigger = DriverTrigger::new(driver.clone());

        for ended in [
            json!({ "type": "turn/completed", "rounds": 1, "stopped": true }),
            json!({ "type": "turn/completed", "rounds": 1, "error": "the provider broke" }),
        ] {
            assert!(
                trigger
                    .on_session_event("s1", &json!({ "type": "model/request" }))
                    .is_none()
            );
            assert!(
                trigger.on_session_event("s1", &ended).is_none(),
                "no pass after {ended}"
            );
        }
        assert!(calls.lock().unwrap().is_empty(), "no round ran");

        // The session is at rest again, and a settled turn or a goal change still requests a pass.
        let run = trigger.on_session_event("s1", &json!({ "type": "turn/completed", "rounds": 1 }));
        assert!(run.is_some(), "a settled turn requests a pass");
        let _ = run.unwrap().await;
        assert!(
            trigger
                .on_session_event("s1", &json!({ "type": "goal/change" }))
                .is_some(),
            "a goal change at rest still does"
        );
        assert!(turn_ended_abnormally(&json!({ "stopped": true })));
        assert!(turn_ended_abnormally(&json!({ "error": "x" })));
        assert!(!turn_ended_abnormally(
            &json!({ "stopped": false, "rounds": 2 })
        ));
    }

    #[test]
    fn a_request_from_a_thread_outside_any_runtime_runs_on_the_drivers_runtime() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let (log, goals) = setup();
        create(&goals, 2.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::with_runtime(
            goals.clone(),
            Arc::new(runner(&log, &calls)),
            runtime.handle().clone(),
        );
        // A plain thread, as a session event appended off the runtime would be.
        let run = std::thread::spawn({
            let driver = driver.clone();
            move || driver.request("s1")
        })
        .join()
        .unwrap();
        let outcome = runtime.block_on(run);
        assert_eq!(outcome.rounds, 2, "{outcome:?}");
        assert_eq!(outcome.stopped, "round-limit");
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn with_no_runtime_anywhere_a_request_answers_an_error_instead_of_panicking() {
        let (log, goals) = setup();
        create(&goals, 2.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let outcome = futures::executor::block_on(driver.request("s1"));
        assert_eq!(outcome.stopped, "no-runtime");
        assert_eq!(outcome.error.as_deref(), Some(NO_RUNTIME_SENTENCE));
        assert!(calls.lock().unwrap().is_empty(), "no round ran");
        // The lane was not left busy: a driver with a runtime afterwards still works on the same goals.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let later = GoalDriver::with_runtime(
            goals,
            Arc::new(runner(&log, &calls)),
            runtime.handle().clone(),
        );
        let outcome = runtime.block_on(later.request("s1"));
        assert_eq!(outcome.rounds, 2, "{outcome:?}");
    }

    #[test]
    fn the_trigger_fed_from_outside_the_runtime_continues_an_armed_goal_after_a_turn() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let (log, goals) = setup();
        create(&goals, 1.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::with_runtime(
            goals.clone(),
            Arc::new(runner(&log, &calls)),
            runtime.handle().clone(),
        );
        let trigger = Arc::new(DriverTrigger::new(driver));
        // What a bus listener on session/event does, on the thread that appended the event.
        let run = std::thread::spawn({
            let trigger = trigger.clone();
            move || {
                assert!(
                    trigger
                        .on_session_event("s1", &json!({ "type": "model/request" }))
                        .is_none(),
                    "mid-turn: no request"
                );
                trigger.on_session_event("s1", &json!({ "type": "turn/completed" }))
            }
        })
        .join()
        .unwrap()
        .expect("a completed turn requests the driver");
        let outcome = runtime.block_on(run);
        assert_eq!(outcome.rounds, 1, "{outcome:?}");
        assert_eq!(outcome.stopped, "round-limit");
    }
}
