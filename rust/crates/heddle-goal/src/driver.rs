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
use serde_json::{Value, json};

use crate::service::{GoalActivation, GoalBlockReason, GoalPhase, GoalRef, GoalService, GoalView};

/// The block code used when the round cap is reached — DSH's own.
pub const ROUND_LIMIT_CODE: &str = "round-limit";

/// The block code used when a round cannot be started at all.
pub const QUEUE_FAILED_CODE: &str = "queue-failed";

/// The block code DSH writes when a goal round is rejected before entering its step (dsh-goal-round-driver
/// lib/index.js:326-333).
pub const PROMPT_REJECTED_CODE: &str = "prompt-rejected";

/// DSH's sentence for that block.
pub const PROMPT_REJECTED_MESSAGE: &str = "Goal round was rejected before entering its step.";

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
    /// `cleared`, `round-not-admitted`, `prompt-rejected`, `turn-failed`, `no-runtime`, …
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
    /// One of this driver's rounds is running in the session now.
    round_running: bool,
    /// The running round was stopped by the caller: the goal is paused once the round returns.
    cancelled: bool,
}

/// How a turn ended, as far as the driver acts on it: the `turn/end` reasons DSH's driver listens for
/// (`TurnEnd` in `src/goal/driver.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnEnd {
    /// Anything else.
    Completed,
    /// The caller cancelled it (DSH's `aborted`).
    Stopped,
    /// It failed (DSH's `agent/error`).
    Failed,
    /// Its last answer was cut at the output limit.
    MaxTokens,
}

/// Read how a turn ended from its last `assistant/completed` and its `turn/completed` (`turnEndOf`).
///
/// A turn that failed or was cut mid-stream writes `turn/completed` with `stopped: true` or an `error`. A turn
/// stopped between steps ends normally, and only its `assistant/completed` says so: `ended` carries "stopped by the
/// caller", or the finish reason is `aborted`. A cut at the output limit is the canonical `max_output_tokens`.
pub fn turn_end_of(completed: Option<&Value>, closing: &Value) -> TurnEnd {
    let finish = completed
        .and_then(|completed| completed.get("finishReason"))
        .and_then(Value::as_str);
    let stopped_by_caller = completed
        .and_then(|completed| completed.get("ended"))
        .and_then(Value::as_array)
        .is_some_and(|ended| {
            ended
                .iter()
                .any(|line| line.as_str() == Some("stopped by the caller"))
        });
    if closing.get("stopped") == Some(&Value::Bool(true))
        || finish == Some("aborted")
        || stopped_by_caller
    {
        return TurnEnd::Stopped;
    }
    if closing.get("error").is_some_and(|error| !error.is_null()) || finish == Some("error") {
        return TurnEnd::Failed;
    }
    if finish == Some("max_output_tokens") {
        return TurnEnd::MaxTokens;
    }
    TurnEnd::Completed
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
            round_running: false,
            cancelled: false,
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

    /// Tell the driver how one of the session's turns ended (DSH's `turn/end` and `agent/error` listeners,
    /// `dsh-goal-round-driver/lib/index.js:211-213, 265-284`; `turnEnded` in `src/goal/driver.ts`).
    ///
    /// - A turn stopped while one of this driver's rounds runs is that round, cancelled: the goal is **paused** once
    ///   the round returns ("a goal whose round was under way is paused at the next idle point").
    /// - A turn stopped while no round runs only **disarms** continuation.
    /// - A failed turn, or one cut at the output limit, disarms continuation ("No abnormal auto-retry"; the driver
    ///   "stops on its own when a turn ends on max tokens"). A person's resume re-arms it.
    pub fn turn_ended(&self, session: &str, end: TurnEnd) {
        if end == TurnEnd::Completed {
            return;
        }
        if end == TurnEnd::Stopped {
            let mut lanes = self
                .lanes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(lane) = lanes.get_mut(session).filter(|lane| lane.round_running) {
                lane.cancelled = true;
                return;
            }
        }
        let _ = self.goals.disarm(session);
    }

    /// Mark whether one of this driver's rounds is running in `session`, clearing a stale cancel when one starts.
    fn set_round_running(&self, session: &str, running: bool) {
        let mut lanes = self
            .lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(lane) = lanes.get_mut(session) {
            lane.round_running = running;
            if running {
                lane.cancelled = false;
            }
        }
    }

    /// Whether the round that just returned was cancelled, clearing the mark.
    fn take_cancelled(&self, session: &str) -> bool {
        let mut lanes = self
            .lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        lanes
            .get_mut(session)
            .is_some_and(|lane| std::mem::take(&mut lane.cancelled))
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
                    // Where this round's own events start, so a round that was not admitted can be read back.
                    let mark = self
                        .goals
                        .session_events(session)
                        .map_or(0, |events| events.len());
                    let source = GoalRoundSource {
                        kind: "goal".to_owned(),
                        goal_id: goal_id.clone(),
                        revision,
                        round,
                    };
                    self.set_round_running(session, true);
                    let ran = self.runner.run(session, prompt, source).await;
                    self.set_round_running(session, false);
                    // The round was stopped (#93): DSH pauses the goal whose round was under way, so nothing
                    // continues on its own and a person's resume starts the next round.
                    if self.take_cancelled(session) {
                        let mut error = None;
                        if let Ok(Some(current)) = self.goals.get(session)
                            && current.goal.id == goal_id
                            && current.goal.phase == GoalPhase::Active
                        {
                            let reference = GoalRef {
                                id: current.goal.id.clone(),
                                revision: current.goal.revision,
                            };
                            if let Err(paused) = self.goals.pause(session, &reference) {
                                let _ = self.goals.disarm(session);
                                error = Some(paused.to_string());
                            }
                        }
                        return DriverOutcome {
                            rounds: rounds + 1,
                            stopped: "cancelled".to_owned(),
                            blocked: None,
                            error,
                        };
                    }
                    // A failed round keeps the goal's phase; its own end disarmed continuation (`turn_ended`), so
                    // nothing retries it on its own.
                    if let Err(error) = ran {
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
                        // DSH's `prompt-rejected`: a round whose step was rejected before it entered — here, the
                        // archived-session gate refusing the round's first step, whose turn ends `blocked` — blocks
                        // the goal it served, when that goal is still the same revision, active and armed
                        // (dsh-goal-round-driver lib/index.js:326-333). The goal is then not run again by itself,
                        // and after an unarchive a person's resume starts it, as it does in DSH; left active and
                        // armed, the resume was refused as "already active and armed".
                        if self.ended_blocked_since(session, mark)
                            && after.goal.id == goal_id
                            && after.goal.revision == revision
                            && after.goal.phase == GoalPhase::Active
                            && after.activation == GoalActivation::Armed
                        {
                            let reason = GoalBlockReason {
                                code: PROMPT_REJECTED_CODE.to_owned(),
                                message: PROMPT_REJECTED_MESSAGE.to_owned(),
                            };
                            let outcome = self.goals.block(
                                session,
                                &GoalRef {
                                    id: goal_id,
                                    revision,
                                },
                                &json!({ "code": reason.code, "message": reason.message }),
                            );
                            return DriverOutcome {
                                rounds,
                                stopped: PROMPT_REJECTED_CODE.to_owned(),
                                blocked: Some(reason),
                                error: outcome.err().map(|error| error.to_string()),
                            };
                        }
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

    /// Whether the events `session` gained since `mark` end a turn with DSH's `blocked`: the archived-session gate's
    /// `turn/failed` `{"reason": {"kind": "blocked"}}`, the one turn end heddle writes for a rejected step.
    fn ended_blocked_since(&self, session: &str, mark: usize) -> bool {
        self.goals
            .session_events(session)
            .is_ok_and(|events| events.iter().skip(mark).any(is_blocked_turn_end))
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
    /// `turn/failed`: a turn's other end (the archived-session gate's `{"kind": "blocked"}`, a teammate's failed
    /// turn). The session is idle again, but no pass is requested: a round started from a refused turn's end
    /// would be refused again.
    TurnFailed,
    /// `model/request`, `assistant/chunk`, `turn/retry`, `tool/result`: a turn is in flight.
    TurnActivity,
    /// `goal/change`: request a pass if the session is at rest; a running turn's completion re-evaluates.
    GoalChange,
    /// Anything else.
    Other,
}

/// Whether `event` ends its turn with DSH's `blocked`: the archived-session gate's `turn/failed`
/// `{"reason": {"kind": "blocked"}}`, the one turn end heddle writes for a rejected step (`isBlockedTurnEnd` in
/// `src/goal/driver.ts`). Any other `turn/failed` (a teammate's turn that failed, whose `reason` is its error) is a
/// failure, DSH's `agent/error`.
fn is_blocked_turn_end(event: &Value) -> bool {
    event["type"] == "turn/failed" && event["reason"]["kind"] == "blocked"
}

/// Classify a session event by its `type`.
pub fn classify_session_event(event_type: &str) -> SessionEdge {
    match event_type {
        "turn/completed" => SessionEdge::TurnCompleted,
        "turn/failed" => SessionEdge::TurnFailed,
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
    /// Each session's last `assistant/completed`, read at its `turn/completed` to tell how the turn ended.
    last_completed: Mutex<HashMap<String, Value>>,
}

impl DriverTrigger {
    /// A trigger for `driver`.
    pub fn new(driver: Arc<GoalDriver>) -> DriverTrigger {
        DriverTrigger {
            driver,
            in_turn: Mutex::new(HashSet::new()),
            last_completed: Mutex::new(HashMap::new()),
        }
    }

    /// One appended event of `session`, whole: what the boot forwards. Like
    /// [`on_session_event`](DriverTrigger::on_session_event), and it also reads how a turn ended (#93, DSH's
    /// `turn/end` listener): a stopped goal round pauses its goal, and any other stopped, failed or length-cut turn
    /// disarms continuation ([`GoalDriver::turn_ended`]), so no round starts after it.
    pub fn on_event(&self, session: &str, event: &Value) -> Option<DriverRun> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "assistant/completed" => {
                self.last_completed
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(session.to_owned(), event.clone());
                None
            }
            "turn/completed" => {
                let completed = self
                    .last_completed
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(session);
                self.driver
                    .turn_ended(session, turn_end_of(completed.as_ref(), event));
                self.on_session_event(session, kind)
            }
            // The gate's refusal (`{"kind": "blocked"}`, DSH's `turn/end` `blocked`) leaves the goal armed, so a
            // refused goal round can block it `prompt-rejected` in the driver; any other `turn/failed` is a failure
            // and disarms continuation, as DSH's `agent/error` listener does (dsh-goal-round-driver
            // lib/index.js:211-213) and a failed `turn/completed` does (#93). Either way the busy span ends and no
            // pass is requested ([`SessionEdge::TurnFailed`]).
            "turn/failed" => {
                self.last_completed
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(session);
                if !is_blocked_turn_end(event) {
                    self.driver.turn_ended(session, TurnEnd::Failed);
                }
                self.on_session_event(session, kind)
            }
            _ => self.on_session_event(session, kind),
        }
    }

    /// One appended event of `session`: returns the chain it requested, if it requested one. Never blocks; the
    /// chain is not awaited, so a turn is not held open by the rounds it starts.
    pub fn on_session_event(&self, session: &str, event_type: &str) -> Option<DriverRun> {
        match classify_session_event(event_type) {
            SessionEdge::TurnCompleted => {
                self.in_turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(session);
                self.request_if_known(session)
            }
            // A turn that ended `turn/failed` ends the busy span as a completed one does (DSH's driver is ready again
            // at every idle, dsh-goal-round-driver lib/index.js:84-86, 223-241), so a goal resumed or edited after
            // an unarchive is not ignored. It requests nothing: the turn was refused or failed, and a round started
            // from its end would meet the same refusal (the TypeScript twin measured 353 refused rounds in 300 ms).
            SessionEdge::TurnFailed => {
                self.in_turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(session);
                None
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

    #[test]
    fn turn_end_of_reads_a_stop_a_failure_and_a_length_cut() {
        assert_eq!(
            turn_end_of(Some(&json!({"finishReason": "stop"})), &json!({})),
            TurnEnd::Completed
        );
        assert_eq!(turn_end_of(None, &json!({})), TurnEnd::Completed);
        assert_eq!(
            turn_end_of(
                Some(&json!({"finishReason": "aborted", "ended": ["stopped by the caller"]})),
                &json!({"stopped": true})
            ),
            TurnEnd::Stopped
        );
        assert_eq!(
            turn_end_of(
                Some(&json!({"finishReason": "tool_calls", "ended": ["stopped by the caller"]})),
                &json!({})
            ),
            TurnEnd::Stopped,
            "a turn stopped between steps ends normally"
        );
        assert_eq!(
            turn_end_of(
                Some(&json!({"finishReason": "error"})),
                &json!({"error": "provider down"})
            ),
            TurnEnd::Failed
        );
        assert_eq!(
            turn_end_of(
                Some(&json!({"finishReason": "max_output_tokens"})),
                &json!({})
            ),
            TurnEnd::MaxTokens
        );
    }

    /// A runner whose round ends the way `end` says, telling the driver as the trigger would.
    fn ending_driver(
        log: &Arc<MemoryLog>,
        goals: &Arc<GoalService>,
        calls: &Arc<Mutex<Vec<(u64, String)>>>,
        end: TurnEnd,
        fail: bool,
    ) -> Arc<GoalDriver> {
        let slot: Arc<OnceLock<Arc<GoalDriver>>> = Arc::new(OnceLock::new());
        let slot_in_hook = slot.clone();
        let hook: Hook = Arc::new(move |session: &str, _round: u64| {
            if let Some(driver) = slot_in_hook.get() {
                driver.turn_ended(session, end);
            }
        });
        let mut runner = runner(log, calls);
        runner.hook = Some(hook);
        runner.fail = fail;
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner));
        slot.set(driver.clone()).ok();
        driver
    }

    #[tokio::test]
    async fn a_goal_round_stopped_by_the_caller_pauses_its_goal_and_starts_nothing_more() {
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = ending_driver(&log, &goals, &calls, TurnEnd::Stopped, false);
        let outcome = driver.request("s1").await;
        assert_eq!(calls.lock().unwrap().len(), 1, "one round, not cap-many");
        assert_eq!(outcome.stopped, "cancelled");
        assert_eq!(outcome.rounds, 1);
        let after = goals.get("s1").unwrap().unwrap();
        assert_eq!(after.goal.phase, GoalPhase::Paused);
        assert_eq!(after.activation, GoalActivation::Disarmed);
        assert_eq!(driver.request("s1").await.stopped, "phase-paused");
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_failed_goal_round_disarms_instead_of_retrying() {
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        // A failing runner never calls its hook, so the failure is told the way the trigger tells it.
        let driver = ending_driver(&log, &goals, &calls, TurnEnd::Failed, true);
        let outcome = driver.request("s1").await;
        assert_eq!(outcome.stopped, "turn-failed");
        driver.turn_ended("s1", TurnEnd::Failed);
        let after = goals.get("s1").unwrap().unwrap();
        assert_eq!(
            after.goal.phase,
            GoalPhase::Active,
            "the goal keeps its phase"
        );
        assert_eq!(
            after.activation,
            GoalActivation::Disarmed,
            "no abnormal auto-retry"
        );
        assert_eq!(driver.request("s1").await.stopped, "disarmed");
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_stopped_turn_outside_a_round_a_failure_and_a_length_cut_only_disarm() {
        for end in [TurnEnd::Stopped, TurnEnd::Failed, TurnEnd::MaxTokens] {
            let (log, goals) = setup();
            create(&goals, 4.0);
            let calls = Arc::new(Mutex::new(Vec::new()));
            let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
            driver.turn_ended("s1", end);
            let after = goals.get("s1").unwrap().unwrap();
            assert_eq!(after.goal.phase, GoalPhase::Active, "{end:?}");
            assert_eq!(after.activation, GoalActivation::Disarmed, "{end:?}");
        }
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)))
            .turn_ended("s1", TurnEnd::Completed);
        assert_eq!(
            goals.get("s1").unwrap().unwrap().activation,
            GoalActivation::Armed
        );
    }

    #[tokio::test]
    async fn the_trigger_reads_the_turns_end_from_its_events_and_requests_no_round_after_a_failure()
    {
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let trigger = DriverTrigger::new(driver);
        assert!(
            trigger
                .on_event("s1", &json!({"type": "model/request"}))
                .is_none()
        );
        assert!(
            trigger
                .on_event(
                    "s1",
                    &json!({"type": "assistant/completed", "finishReason": "error", "ended": ["failed: provider down"]})
                )
                .is_none()
        );
        let run = trigger
            .on_event(
                "s1",
                &json!({"type": "turn/completed", "rounds": 1, "error": "provider down"}),
            )
            .expect("a turn/completed still asks the driver to look");
        assert_eq!(
            run.await.stopped,
            "disarmed",
            "and the failed turn disarmed it first"
        );
        assert!(
            calls.lock().unwrap().is_empty(),
            "no round started after the failure"
        );
    }

    // The archived-session gate (#26) and goal-stop (#93) together: every `turn/failed` ends the busy span and requests
    // nothing; the gate's refusal leaves the goal armed (DSH's `turn/end` `blocked` does not disarm, so a refused round
    // can block `prompt-rejected`), and a failed teammate turn disarms, as DSH's `agent/error` does.
    #[tokio::test]
    async fn a_refused_turn_failed_leaves_the_goal_armed_and_a_failed_one_disarms_it() {
        let (log, goals) = setup();
        create(&goals, 4.0);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let trigger = DriverTrigger::new(driver);
        assert!(
            trigger
                .on_event("s1", &json!({"type": "model/request"}))
                .is_none()
        );
        assert!(
            trigger
                .on_event(
                    "s1",
                    &json!({"type": "turn/failed", "reason": {"kind": "blocked"}})
                )
                .is_none(),
            "a refused turn's end requests nothing"
        );
        assert_eq!(
            goals.get("s1").unwrap().unwrap().activation,
            GoalActivation::Armed,
            "and leaves the goal armed"
        );
        assert!(
            trigger
                .on_event("s1", &json!({"type": "model/request"}))
                .is_none()
        );
        assert!(
            trigger
                .on_event(
                    "s1",
                    &json!({"type": "turn/failed", "reason": "provider down"})
                )
                .is_none(),
            "a failed turn's end requests nothing"
        );
        let after = goals.get("s1").unwrap().unwrap();
        assert_eq!(
            after.goal.phase,
            GoalPhase::Active,
            "the goal keeps its phase"
        );
        assert_eq!(
            after.activation,
            GoalActivation::Disarmed,
            "and is disarmed: no abnormal auto-retry"
        );
        let run = trigger
            .on_event("s1", &json!({"type": "goal/change"}))
            .expect("the session is at rest after turn/failed");
        assert_eq!(run.await.stopped, "disarmed");
        assert!(calls.lock().unwrap().is_empty(), "no round started");
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

        assert!(trigger.on_session_event("s1", "model/request").is_none());
        assert!(
            trigger.on_session_event("s1", "goal/change").is_none(),
            "a goal change inside a turn waits for the completion edge"
        );
        let run = trigger.on_session_event("s1", "turn/completed");
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
        assert!(trigger.on_session_event("s1", "goal/change").is_some());
        assert!(
            trigger.on_session_event("nope", "turn/completed").is_none(),
            "an unknown session is a no-op"
        );
    }

    // developer-five's review of the archived-session gate (issue #26): a turn refused at a later step writes
    // `turn/failed` {"reason":{"kind":"blocked"}}, which the trigger ignored, so the session stayed busy and a goal
    // resumed after the unarchive was ignored until some other turn completed.
    #[tokio::test]
    async fn a_turn_that_ends_failed_leaves_the_session_at_rest_and_a_later_resume_starts_a_round()
    {
        let (log, goals) = setup();
        let created = create(&goals, 1.0);
        let paused = goals
            .pause(
                "s1",
                &GoalRef {
                    id: created.goal.id.clone(),
                    revision: created.goal.revision,
                },
            )
            .unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner(&log, &calls)));
        let trigger = DriverTrigger::new(driver.clone());

        // A person's turn asks the model, then the gate refuses its next step.
        assert!(trigger.on_session_event("s1", "model/request").is_none());
        assert!(
            trigger.on_session_event("s1", "turn/failed").is_none(),
            "the refused turn's end requests nothing by itself"
        );
        // After the unarchive, the person resumes the goal.
        goals
            .resume(
                "s1",
                &GoalRef {
                    id: paused.goal.id.clone(),
                    revision: paused.goal.revision,
                },
            )
            .unwrap();
        let run = trigger.on_session_event("s1", "goal/change");
        assert!(
            run.is_some(),
            "the session is at rest after turn/failed, so the resume requests a pass"
        );
        let outcome = run.unwrap().await;
        assert_eq!(outcome.rounds, 1, "{outcome:?}");
        assert_eq!(calls.lock().unwrap().len(), 1, "the resume started round 1");
        assert_eq!(
            classify_session_event("turn/failed"),
            SessionEdge::TurnFailed
        );
    }

    // The other half of the same review: clearing busy must not start the refused round again. The runner stands
    // for a round the gate refuses at its first step: no message is admitted, the turn's `turn/failed` end is
    // appended, and it reaches the trigger while the chain is still running, as the boot forwards it.
    #[tokio::test]
    async fn a_refused_round_is_not_started_again_by_its_own_turn_failed_end() {
        let (log, goals) = setup();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let cell: Arc<OnceLock<Arc<DriverTrigger>>> = Arc::new(OnceLock::new());
        let hook: Hook = {
            let cell = Arc::clone(&cell);
            let log = log.clone();
            Arc::new(move |session: &str, _round: u64| {
                log.append_raw(
                    session,
                    json!({ "type": "turn/failed", "reason": { "kind": "blocked" } }),
                );
                if let Some(trigger) = cell.get() {
                    drop(trigger.on_session_event(session, "turn/failed"));
                }
            })
        };
        let refused = TestRunner {
            log: log.clone(),
            calls: calls.clone(),
            hook: Some(hook),
            fail: false,
            record: false,
        };
        let driver = GoalDriver::new(goals.clone(), Arc::new(refused));
        let trigger = Arc::new(DriverTrigger::new(driver.clone()));
        assert!(cell.set(Arc::clone(&trigger)).is_ok());
        create(&goals, 5.0);
        let outcome = trigger
            .on_session_event("s1", "goal/change")
            .expect("at rest, a goal change requests a pass")
            .await;
        assert_eq!(outcome.stopped, PROMPT_REJECTED_CODE, "{outcome:?}");
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            calls.lock().unwrap().len(),
            1,
            "the refused round ran once and its own end did not start it again"
        );
        assert_eq!(
            goals.get("s1").unwrap().unwrap().goal.phase,
            GoalPhase::Blocked,
            "the refused round blocked its goal, as DSH's does"
        );
    }

    /// A round runner over a session the archived-session gate may refuse: while `archived`, the round's first step
    /// is rejected (no message admitted, the turn ends `turn/failed` {"reason":{"kind":"blocked"}}); otherwise the
    /// round is admitted and its turn completes.
    struct GatedRunner {
        log: Arc<MemoryLog>,
        archived: Arc<std::sync::atomic::AtomicBool>,
        calls: Arc<Mutex<Vec<(u64, String)>>>,
    }

    impl RoundRunner for GatedRunner {
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
            if self.archived.load(std::sync::atomic::Ordering::SeqCst) {
                self.log.append_raw(
                    session,
                    json!({ "type": "turn/failed", "reason": { "kind": "blocked" } }),
                );
            } else {
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
                self.log
                    .append_raw(session, json!({ "type": "turn/completed", "rounds": 1 }));
            }
            Box::pin(async { Ok(()) })
        }
    }

    // DSH blocks a goal whose round its pre-step rejects, with `prompt-rejected` (dsh-goal-round-driver
    // lib/index.js:326-333). Before this, heddle stopped the chain as `round-not-admitted` and left the goal active
    // and armed, so after an unarchive a resume was refused as "already active and armed".
    #[tokio::test]
    async fn a_round_refused_before_its_step_blocks_the_goal_and_a_resume_after_the_unarchive_runs_it()
     {
        let (log, goals) = setup();
        let archived = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let driver = GoalDriver::new(
            goals.clone(),
            Arc::new(GatedRunner {
                log: log.clone(),
                archived: archived.clone(),
                calls: calls.clone(),
            }),
        );
        create(&goals, 1.0);
        let outcome = driver.request("s1").await;
        assert_eq!(outcome.stopped, PROMPT_REJECTED_CODE, "{outcome:?}");
        assert_eq!(outcome.rounds, 0, "the refused round was not admitted");
        let blocked = goals.get("s1").unwrap().unwrap();
        assert_eq!(
            blocked.goal.phase,
            GoalPhase::Blocked,
            "the goal is blocked, not left active and armed"
        );
        assert_eq!(
            blocked.goal.blocked_reason,
            Some(GoalBlockReason {
                code: "prompt-rejected".into(),
                message: "Goal round was rejected before entering its step.".into(),
            }),
            "with DSH's code and sentence"
        );
        assert_eq!(calls.lock().unwrap().len(), 1);

        archived.store(false, std::sync::atomic::Ordering::SeqCst);
        goals
            .resume(
                "s1",
                &GoalRef {
                    id: blocked.goal.id.clone(),
                    revision: blocked.goal.revision,
                },
            )
            .unwrap();
        let outcome = driver.request("s1").await;
        assert_eq!(outcome.rounds, 1, "the resume ran round 1: {outcome:?}");
        assert_eq!(outcome.stopped, "round-limit");
        assert_eq!(calls.lock().unwrap().len(), 2);
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
                    trigger.on_session_event("s1", "model/request").is_none(),
                    "mid-turn: no request"
                );
                trigger.on_session_event("s1", "turn/completed")
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
