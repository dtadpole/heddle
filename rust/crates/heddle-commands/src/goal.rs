//! `/goal` — set, show, edit, pause, resume or clear the session's goal, as DSH's `dsh-command-goal` does.
//!
//! Ported from `src/commands/goal.ts`, which is read from DSH 0.2.1-rc.2's
//! `@deepseek-ai/dsh-command-goal/lib/index.js` and its extraction in
//! `_projects_/heddle/_designs_/dsh-parity/goals-todo-spec.md` section B1; the line numbers below are that file's.
//! Developer-nine owns these semantics (D-059); the command layer that runs them — the registry, the
//! `command/run` and `command/done` events, the route and the page — is developer-three's (D-057), so section B2
//! is not here.
//!
//! What a person can type, decided only by [`parse_goal_command`] (:19-35):
//!
//! - nothing: show the goal, or say none is set;
//! - `clear`, `pause` or `resume`, the **whole** input, in any case: act on the goal;
//! - `edit <objective>`: replace the objective — `edit` alone is refused, and `edit` must be followed by
//!   whitespace;
//! - anything else: create a goal whose objective is the whole input, so `/goal pause after verification` sets
//!   that objective rather than pausing. There is no round-cap argument.
//!
//! A person's command carries **no authority checks**: those are the model's tools' (`heddle_goal::tool`). So
//! `/goal resume` resumes a goal a person paused, and a created goal is armed at once. Every refusal the goal
//! service raises (stale revision, invalid transition, an exhausted cap, a missing goal) is one sentence,
//! [`GOAL_STATE_ERROR`] (:165-171); anything else is not the goal domain's and is passed on as the handler's
//! `Err`, so the layer records it as the run's error.

use std::sync::Arc;

use heddle_goal::{
    CreateGoal, EditGoal, GoalActivation, GoalError, GoalErrorCode, GoalPhase, GoalRef,
    GoalService, GoalView,
};
use heddle_llm::{ContentPart, Message, Role};
use heddle_session::SessionHandle;
use serde_json::json;

use crate::registry::{
    CommandAction, CommandContext, CommandDefinition, CommandInput, CommandResult, CommandSection,
    HandlerOutcome,
};
use crate::text;

/// The usage line every refusal that needs one ends with (:11).
pub const GOAL_USAGE: &str = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume]";

/// The argument shape the menu shows (:180).
pub const GOAL_INPUT_HINT: &str = "[<objective>|clear|edit <objective>|pause|resume]";

/// The one answer to any refusal from the goal service (:165-171).
pub const GOAL_STATE_ERROR: &str =
    "The goal command is not valid for the current state. Run /goal to view available commands.";

/// The refusal of attachments on a form that sets no objective (:111-114).
pub const GOAL_ATTACHMENTS_REFUSED: &str =
    "Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.";

/// The text that follows a goal objective's attachments in their follow-up message (:101-104).
pub const GOAL_ATTACHMENTS_TEXT: &str = "Reference attachments for the goal objective.";

/// Why a goal operation did not happen.
///
/// The TypeScript handler tells the two apart with `instanceof GoalError` (:166): a refusal is the goal domain's
/// and reads as [`GOAL_STATE_ERROR`]; anything else is thrown on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalHostError {
    /// The goal service refused — a [`GoalError::Refused`]: a stale revision, an invalid transition, an exhausted
    /// cap, a missing goal, an invalid objective.
    Refused {
        /// Which refusal.
        code: GoalErrorCode,
        /// The service's sentence, which a person never reads.
        message: String,
    },
    /// Anything that is not the goal domain's — the session log failed, no goal service is loaded — passed on
    /// as the run's error with this sentence.
    Failed(String),
}

impl From<GoalError> for GoalHostError {
    fn from(error: GoalError) -> Self {
        match error {
            GoalError::Refused { code, message } => GoalHostError::Refused { code, message },
            // A log failure is not a `GoalError` in the TypeScript build, so it is not the generic sentence.
            GoalError::Log(error) => GoalHostError::Failed(error.0),
        }
    }
}

/// The goal operations `/goal` drives: the goal service's own methods, with its own view and reference.
pub trait GoalHost: Send + Sync {
    /// The current goal, if any.
    fn get(&self, session: &SessionHandle) -> Result<Option<GoalView>, GoalHostError>;
    /// Create a goal with this objective and the configured round cap, armed.
    fn create(&self, session: &SessionHandle, objective: &str) -> Result<GoalView, GoalHostError>;
    /// Replace the objective of the goal at this exact revision.
    fn edit(
        &self,
        session: &SessionHandle,
        goal: &GoalRef,
        objective: &str,
    ) -> Result<GoalView, GoalHostError>;
    /// Pause it.
    fn pause(&self, session: &SessionHandle, goal: &GoalRef) -> Result<GoalView, GoalHostError>;
    /// Resume it.
    fn resume(&self, session: &SessionHandle, goal: &GoalRef) -> Result<GoalView, GoalHostError>;
    /// Clear it.
    fn clear(&self, session: &SessionHandle, goal: &GoalRef) -> Result<(), GoalHostError>;
}

/// The goal service is a goal host as it is: each call names the session by its id.
impl GoalHost for GoalService {
    fn get(&self, session: &SessionHandle) -> Result<Option<GoalView>, GoalHostError> {
        Ok(GoalService::get(self, &session.id)?)
    }

    fn create(&self, session: &SessionHandle, objective: &str) -> Result<GoalView, GoalHostError> {
        Ok(GoalService::create(
            self,
            &session.id,
            CreateGoal {
                objective: objective.to_owned(),
                max_goal_rounds: None,
            },
        )?)
    }

    fn edit(
        &self,
        session: &SessionHandle,
        goal: &GoalRef,
        objective: &str,
    ) -> Result<GoalView, GoalHostError> {
        Ok(GoalService::edit(
            self,
            &session.id,
            goal,
            EditGoal {
                objective: Some(objective.to_owned()),
                max_goal_rounds: None,
            },
        )?)
    }

    fn pause(&self, session: &SessionHandle, goal: &GoalRef) -> Result<GoalView, GoalHostError> {
        Ok(GoalService::pause(self, &session.id, goal)?)
    }

    fn resume(&self, session: &SessionHandle, goal: &GoalRef) -> Result<GoalView, GoalHostError> {
        Ok(GoalService::resume(self, &session.id, goal)?)
    }

    fn clear(&self, session: &SessionHandle, goal: &GoalRef) -> Result<(), GoalHostError> {
        GoalService::clear(self, &session.id, goal)?;
        Ok(())
    }
}

/// Where a goal objective's attachments go: one follow-up message, queued to start a turn after the command.
///
/// DSH calls `agent.followup(message)` (:100). The command layer offers no such call yet, so the commands host
/// passes none and [`goal_command`] does not deliver the message — see the TODO in `submit_objective_attachments`.
pub type GoalFollowupSink = Arc<dyn Fn(&SessionHandle, Message) + Send + Sync>;

/// One parsed `/goal` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalCommand {
    /// Nothing typed: show the goal.
    Show,
    /// `clear`.
    Clear,
    /// `pause`.
    Pause,
    /// `resume`.
    Resume,
    /// `edit` with nothing after it.
    InvalidEdit,
    /// `edit <objective>`.
    Edit {
        /// The replacement objective, trimmed.
        objective: String,
    },
    /// Anything else: a new goal.
    Create {
        /// The whole input, trimmed.
        objective: String,
    },
}

/// Parse only the grammar `/goal` owns; any other input is an objective (:19-35).
pub fn parse_goal_command(raw_input: &str) -> GoalCommand {
    let input = text::trim(raw_input);
    if input.is_empty() {
        return GoalCommand::Show;
    }
    // `input.toLowerCase()`: only whole-input equality with the four ASCII words is asked of it.
    match input.to_lowercase().as_str() {
        "clear" => return GoalCommand::Clear,
        "pause" => return GoalCommand::Pause,
        "resume" => return GoalCommand::Resume,
        "edit" => return GoalCommand::InvalidEdit,
        _ => {}
    }
    // `/^edit(?=\s)/iu`: no character outside ASCII case-folds to `e`, `d`, `i` or `t`, and `\s` under `u` is the
    // set `String#trim` removes. The four bytes matched are ASCII, so `slice(4)` is the byte offset 4.
    let bytes = input.as_bytes();
    if bytes.len() > 4
        && bytes[..4].eq_ignore_ascii_case(b"edit")
        && input[4..].starts_with(text::is_space)
    {
        return GoalCommand::Edit {
            objective: text::trim(&input[4..]).to_owned(),
        };
    }
    GoalCommand::Create {
        objective: input.to_owned(),
    }
}

/// The goal as `/goal` shows it, under a title: DSH's lines, joined by newlines (:59-77).
///
/// A blocked goal without its reason cannot be shown; the `Err` is that sentence, as the TypeScript build throws
/// it.
pub fn render_goal(title: &str, goal: &GoalView) -> Result<String, String> {
    let snapshot = &goal.goal;
    let mut lines = vec![
        title.to_owned(),
        format!("Status: {}", phase_label(snapshot.phase)),
    ];
    if snapshot.phase == GoalPhase::Blocked {
        let Some(reason) = &snapshot.blocked_reason else {
            return Err("blocked goal is missing its reason".to_owned());
        };
        lines.push(format!("Blocker: {}: {}", reason.code, reason.message));
    }
    lines.extend([
        format!("Objective: {}", snapshot.objective),
        format!(
            "Rounds: {}/{}",
            goal.rounds_started, snapshot.max_goal_rounds
        ),
        format!("Activation: {}", goal.activation.as_str()),
        String::new(),
        format!(
            "Commands: {}",
            command_hint(snapshot.phase, goal.activation)
        ),
    ]);
    Ok(lines.join("\n"))
}

/// The commands that mean something from the goal's exact live state (:48-57).
pub fn command_hint(phase: GoalPhase, activation: GoalActivation) -> &'static str {
    match (phase, activation) {
        (GoalPhase::Active, GoalActivation::Armed) => {
            "/goal edit <objective>, /goal pause, /goal clear"
        }
        (GoalPhase::Active, GoalActivation::Disarmed)
        | (GoalPhase::Paused | GoalPhase::Blocked, _) => {
            "/goal edit <objective>, /goal resume, /goal clear"
        }
        (GoalPhase::Complete, _) => "/goal <objective>, /goal clear",
    }
}

/// The follow-up message for a goal objective's attachments, or `None` when there are none (:98-107).
///
/// A user message: the attachments in the order they came, then [`GOAL_ATTACHMENTS_TEXT`]; its source is a
/// person's (`{kind: "user"}`), which is what the follow-up turn's authority rests on.
pub fn goal_attachment_followup(attachments: &[ContentPart]) -> Option<Message> {
    if attachments.is_empty() {
        return None;
    }
    let mut content = attachments.to_vec();
    content.push(ContentPart::text(GOAL_ATTACHMENTS_TEXT));
    Some(Message {
        role: Role::User,
        tool_call_id: None,
        content,
        source: Some(json!({"kind": "user"})),
    })
}

/// The `/goal` command over the goal service.
///
/// Its input accepts attachments, so the layer hands the files sent with the line to the handler as
/// [`CommandContext::attachments`], already read as message parts, and the handler passes them to
/// [`execute_goal_command`]. `followup` is where a create's or an edit's attachments go once the goal has
/// changed; when it is `None` they go nowhere yet (the TODO in `submit_objective_attachments`).
pub fn goal_command(
    goals: Arc<dyn GoalHost>,
    followup: Option<GoalFollowupSink>,
) -> CommandDefinition {
    CommandDefinition::sync(
        "goal",
        "Set or view the goal for a long-running task",
        move |context| {
            execute_goal_command(
                goals.as_ref(),
                followup.as_ref(),
                &context,
                &context.attachments,
            )
        },
    )
    .label("Goal")
    .section(CommandSection::Add)
    .input(CommandInput {
        hint: GOAL_INPUT_HINT.to_owned(),
        attachments: Some(true),
    })
}

/// Run one `/goal` line, with the attachments that travelled with it, through the goal service, which owns every
/// write (:109-172).
///
/// This is `goal.ts`'s handler; the registered one passes the layer's `context.attachments`. An empty slice is no
/// attachments. The `Err` is a failure that is not the goal domain's, for the layer to record as the run's error.
pub fn execute_goal_command(
    goals: &dyn GoalHost,
    followup: Option<&GoalFollowupSink>,
    context: &CommandContext,
    attachments: &[ContentPart],
) -> HandlerOutcome {
    let command = parse_goal_command(&context.raw_input);
    if !attachments.is_empty()
        && !matches!(
            command,
            GoalCommand::Create { .. } | GoalCommand::Edit { .. }
        )
    {
        return Ok(CommandResult::error(GOAL_ATTACHMENTS_REFUSED));
    }
    match run(goals, followup, &context.session, command, attachments) {
        Ok(result) => Ok(result),
        Err(GoalHostError::Refused { .. }) => Ok(CommandResult::error(GOAL_STATE_ERROR)),
        Err(GoalHostError::Failed(message)) => Err(message),
    }
}

/// The parsed line against the goal as it is now.
fn run(
    goals: &dyn GoalHost,
    followup: Option<&GoalFollowupSink>,
    session: &SessionHandle,
    command: GoalCommand,
    attachments: &[ContentPart],
) -> Result<CommandResult, GoalHostError> {
    let current = goals.get(session)?;
    Ok(match command {
        GoalCommand::Show => match &current {
            None => CommandResult::success_text(format!("No goal is currently set.\n{GOAL_USAGE}")),
            Some(goal) => CommandResult::success_text(card("Goal", goal)?),
        },
        GoalCommand::InvalidEdit => CommandResult::error(format!(
            "Goal editing requires a replacement objective.\n{GOAL_USAGE}"
        )),
        GoalCommand::Create { objective } => {
            if let Some(current) = &current
                && current.goal.phase != GoalPhase::Complete
            {
                return Ok(CommandResult::error(format!(
                    "A goal is already {}. Use /goal edit <objective> to change it or /goal clear before replacing it.",
                    phase_label(current.goal.phase)
                )));
            }
            let created = goals.create(session, &objective)?;
            with_followup(
                CommandResult::success_text(card("Goal created", &created)?),
                submit_objective_attachments(followup, session, attachments),
            )
        }
        GoalCommand::Edit { objective } => {
            let Some(current) = &current else {
                return Ok(missing_goal("edit"));
            };
            if current.goal.phase == GoalPhase::Complete {
                let replaced = goals.create(session, &objective)?;
                return Ok(with_followup(
                    CommandResult::success_text(card("Goal created", &replaced)?),
                    submit_objective_attachments(followup, session, attachments),
                ));
            }
            let edited = goals.edit(session, &current.goal.goal_ref(), &objective)?;
            with_followup(
                CommandResult::success_text(card("Goal updated", &edited)?),
                submit_objective_attachments(followup, session, attachments),
            )
        }
        GoalCommand::Pause => {
            let Some(current) = &current else {
                return Ok(missing_goal("pause"));
            };
            let paused = goals.pause(session, &current.goal.goal_ref())?;
            CommandResult::success_text(card("Goal paused", &paused)?)
        }
        GoalCommand::Resume => {
            let Some(current) = &current else {
                return Ok(missing_goal("resume"));
            };
            let resumed = goals.resume(session, &current.goal.goal_ref())?;
            CommandResult::success_text(card("Goal resumed", &resumed)?)
        }
        GoalCommand::Clear => {
            let Some(current) = &current else {
                return Ok(CommandResult::success_text("No goal to clear."));
            };
            goals.clear(session, &current.goal.goal_ref())?;
            CommandResult::success_text("Goal cleared.")
        }
    })
}

/// [`render_goal`], its one failure passed on as a failure that is not the goal domain's.
fn card(title: &str, goal: &GoalView) -> Result<String, GoalHostError> {
    render_goal(title, goal).map_err(GoalHostError::Failed)
}

/// Hand a goal objective's attachments on as one follow-up message, after the goal has changed (:98-107).
///
/// DSH queues the message on the agent, so the next turn reads the attachments from ordinary history and the goal
/// itself stores no attachment state.
fn submit_objective_attachments(
    followup: Option<&GoalFollowupSink>,
    session: &SessionHandle,
    attachments: &[ContentPart],
) -> Option<CommandAction> {
    let message = goal_attachment_followup(attachments)?;
    if let Some(sink) = followup {
        sink(session, message);
        return None;
    }
    // With no sink — the commands host passes none — the page delivers it (developer-three): a `prompt` action, which
    // the slash menu sends as the next ordinary message together with the files it took for the line, so the model
    // reads the attachments, then this text, as DSH's `agent.followup` puts them.
    Some(CommandAction::Prompt {
        text: GOAL_ATTACHMENTS_TEXT.to_owned(),
    })
}

/// A success with the follow-up's action, when there is one.
fn with_followup(result: CommandResult, action: Option<CommandAction>) -> CommandResult {
    match action {
        Some(action) if result.kind() == "success" => result.with_action(action),
        _ => result,
    }
}

/// The refusal of an action that needs a current goal (:86-91). A space, not a newline, precedes the usage.
fn missing_goal(action: &str) -> CommandResult {
    CommandResult::error(format!(
        "No goal is currently set; /goal {action} requires one. {GOAL_USAGE}"
    ))
}

/// A durable phase as a person reads it (:37-46).
fn phase_label(phase: GoalPhase) -> &'static str {
    match phase {
        GoalPhase::Active => "active",
        GoalPhase::Paused => "paused",
        GoalPhase::Blocked => "blocked",
        GoalPhase::Complete => "complete",
    }
}

#[cfg(test)]
mod tests {
    //! `/goal`'s semantics: DSH's forms and sentences, word for word — `test/commands-goal.test.ts`, case by case.
    //!
    //! Every expected text below is written out rather than taken from the module, so a changed sentence fails
    //! here instead of agreeing with itself. The goal service is the real one over a real session store, so each
    //! refusal is the service's own and each write is a `goal/change` in the log; the doubles appear only where a
    //! state cannot be reached honestly (a stale read).

    use std::sync::Mutex;

    use heddle_goal::{GOAL_CHANGE_EVENT, GoalConfig, LogError, MAX_OBJECTIVE_LENGTH};
    use heddle_llm::{FilePart, ImageMediaType, ImagePart};
    use heddle_session::RecordedMessage;
    use serde_json::json;

    use super::*;
    use crate::registry::{CommandRegistry, parse_command_line};
    use crate::test_support::Fixture;

    const USAGE: &str = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume]";
    const STATE_ERROR: &str = "The goal command is not valid for the current state. Run /goal to view available commands.";
    const ATTACHMENTS_REFUSED: &str =
        "Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.";
    const HINT_ARMED: &str = "/goal edit <objective>, /goal pause, /goal clear";
    const HINT_STOPPED: &str = "/goal edit <objective>, /goal resume, /goal clear";
    const HINT_COMPLETE: &str = "/goal <objective>, /goal clear";

    type Followups = Arc<Mutex<Vec<(SessionHandle, Message)>>>;

    /// One session, its goal service and `/goal` over them. `run` takes a whole line, splits it as the layer
    /// does and passes attachments to the handler; the layer's own run (its context) is pinned at the end.
    struct Harness {
        fixture: Fixture,
        goals: Arc<GoalService>,
        host: Arc<dyn GoalHost>,
        sink: Option<GoalFollowupSink>,
        followups: Followups,
        command: CommandDefinition,
    }

    impl Harness {
        /// The real goal service, with a follow-up sink.
        fn new() -> Self {
            Self::with(|goals| goals, true)
        }

        /// The goal service as `host` presents it, with or without a follow-up sink.
        fn with(host: impl FnOnce(Arc<GoalService>) -> Arc<dyn GoalHost>, sink: bool) -> Self {
            let fixture = Fixture::new("goal-command");
            let goals = Arc::new(GoalService::new(
                fixture.store.clone(),
                GoalConfig::default(),
            ));
            let host = host(Arc::clone(&goals));
            let followups: Followups = Arc::new(Mutex::new(Vec::new()));
            let record = Arc::clone(&followups);
            let sink: Option<GoalFollowupSink> = sink.then(|| {
                Arc::new(move |session: &SessionHandle, message: Message| {
                    record.lock().unwrap().push((session.clone(), message));
                }) as GoalFollowupSink
            });
            let command = goal_command(Arc::clone(&host), sink.clone());
            Self {
                fixture,
                goals,
                host,
                sink,
                followups,
                command,
            }
        }

        fn session(&self) -> &str {
            &self.fixture.handle.id
        }

        /// One line through the handler that takes attachments; an empty slice is none.
        fn try_run(&self, line: &str, attachments: &[ContentPart]) -> HandlerOutcome {
            let parsed = parse_command_line(line)
                .filter(|parsed| parsed.name == "goal")
                .unwrap_or_else(|| panic!("{line:?} is a /goal line"));
            let context = CommandContext {
                session: self.fixture.handle.clone(),
                command_id: "cmd-0000abcd-1".to_owned(),
                args: text::trim(&parsed.raw_input).to_owned(),
                raw_input: parsed.raw_input,
                attachments: attachments.to_vec(),
            };
            execute_goal_command(
                self.host.as_ref(),
                self.sink.as_ref(),
                &context,
                &context.attachments,
            )
        }

        fn run_with(&self, line: &str, attachments: &[ContentPart]) -> CommandResult {
            self.try_run(line, attachments)
                .unwrap_or_else(|message| panic!("{line:?} failed: {message}"))
        }

        fn run(&self, line: &str) -> CommandResult {
            self.run_with(line, &[])
        }

        /// The `goal/change` events in the session's log.
        fn changes(&self) -> usize {
            self.fixture
                .events()
                .iter()
                .filter(|event| event.kind == GOAL_CHANGE_EVENT)
                .count()
        }

        fn followups(&self) -> Vec<(SessionHandle, Message)> {
            self.followups.lock().unwrap().clone()
        }

        fn current(&self) -> Option<GoalView> {
            self.goals.get(self.session()).unwrap()
        }

        fn create(&self, objective: &str) -> GoalView {
            self.create_capped(objective, None)
        }

        fn create_capped(&self, objective: &str, max_goal_rounds: Option<f64>) -> GoalView {
            self.goals
                .create(
                    self.session(),
                    CreateGoal {
                        objective: objective.to_owned(),
                        max_goal_rounds,
                    },
                )
                .unwrap()
        }

        fn pause(&self, goal: &GoalRef) -> GoalView {
            self.goals.pause(self.session(), goal).unwrap()
        }

        fn complete(&self, goal: &GoalRef) -> GoalView {
            self.goals.complete(self.session(), goal).unwrap()
        }

        fn block(&self, goal: &GoalRef, code: &str, message: &str) -> GoalView {
            self.goals
                .block(
                    self.session(),
                    goal,
                    &json!({"code": code, "message": message}),
                )
                .unwrap()
        }

        fn edit(&self, goal: &GoalRef, objective: &str) -> GoalView {
            self.goals
                .edit(
                    self.session(),
                    goal,
                    EditGoal {
                        objective: Some(objective.to_owned()),
                        max_goal_rounds: None,
                    },
                )
                .unwrap()
        }

        fn disarm(&self) {
            self.goals.disarm(self.session()).unwrap();
        }

        /// The user message a goal round starts with, attributed to the goal: what the fold counts as a round.
        fn round_message(&self, goal: &GoalView, round: u64) {
            self.fixture
                .store
                .message(
                    &self.fixture.handle,
                    RecordedMessage {
                        role: Role::User,
                        tool_call_id: None,
                        content: vec![ContentPart::text("<goal_round>")],
                        source: Some(json!({
                            "kind": "goal",
                            "goalId": goal.goal.id,
                            "revision": goal.goal.revision,
                            "round": round,
                        })),
                    },
                )
                .unwrap();
        }
    }

    /// The goal card DSH renders: title, status, an optional blocker, objective, rounds, activation, a gap,
    /// commands.
    struct Card<'a> {
        title: &'a str,
        phase: &'a str,
        blocker: Option<&'a str>,
        objective: &'a str,
        rounds: &'a str,
        activation: &'a str,
        hint: &'a str,
    }

    impl Card<'_> {
        fn text(&self) -> String {
            let mut lines = vec![self.title.to_owned(), format!("Status: {}", self.phase)];
            if let Some(blocker) = self.blocker {
                lines.push(format!("Blocker: {blocker}"));
            }
            lines.extend([
                format!("Objective: {}", self.objective),
                format!("Rounds: {}", self.rounds),
                format!("Activation: {}", self.activation),
                String::new(),
                format!("Commands: {}", self.hint),
            ]);
            lines.join("\n")
        }
    }

    /// A card without a blocker.
    fn card(
        title: &str,
        phase: &str,
        objective: &str,
        rounds: &str,
        activation: &str,
        hint: &str,
    ) -> String {
        Card {
            title,
            phase,
            blocker: None,
            objective,
            rounds,
            activation,
            hint,
        }
        .text()
    }

    fn success(text: impl Into<String>) -> CommandResult {
        CommandResult::success_text(text)
    }

    fn error(text: impl Into<String>) -> CommandResult {
        CommandResult::error(text)
    }

    /// A result's text, whichever kind it is.
    fn text_of(result: &CommandResult) -> String {
        result.text().unwrap_or_default().to_owned()
    }

    fn image() -> ContentPart {
        ContentPart::Image(ImagePart {
            name: "plan.png".to_owned(),
            mime_type: ImageMediaType::Png,
            path: "/uploads/plan.png".to_owned(),
            bytes: 10,
            sha256: "sha256:aa".to_owned(),
            data: None,
        })
    }

    fn file() -> ContentPart {
        ContentPart::File(FilePart {
            name: "spec.md".to_owned(),
            path: "/uploads/spec.md".to_owned(),
            bytes: 34,
            sha256: "sha256:bb".to_owned(),
        })
    }

    fn attachments_text() -> ContentPart {
        ContentPart::text("Reference attachments for the goal objective.")
    }

    /// The goal service with its reads skewed: what a stale read or a vanished goal looks like to `/goal`.
    struct Skewed {
        goals: Arc<GoalService>,
        skew: fn(GoalView) -> GoalView,
    }

    impl GoalHost for Skewed {
        fn get(&self, session: &SessionHandle) -> Result<Option<GoalView>, GoalHostError> {
            Ok(GoalHost::get(self.goals.as_ref(), session)?.map(self.skew))
        }

        fn create(
            &self,
            session: &SessionHandle,
            objective: &str,
        ) -> Result<GoalView, GoalHostError> {
            GoalHost::create(self.goals.as_ref(), session, objective)
        }

        fn edit(
            &self,
            session: &SessionHandle,
            goal: &GoalRef,
            objective: &str,
        ) -> Result<GoalView, GoalHostError> {
            GoalHost::edit(self.goals.as_ref(), session, goal, objective)
        }

        fn pause(
            &self,
            session: &SessionHandle,
            goal: &GoalRef,
        ) -> Result<GoalView, GoalHostError> {
            GoalHost::pause(self.goals.as_ref(), session, goal)
        }

        fn resume(
            &self,
            session: &SessionHandle,
            goal: &GoalRef,
        ) -> Result<GoalView, GoalHostError> {
            GoalHost::resume(self.goals.as_ref(), session, goal)
        }

        fn clear(&self, session: &SessionHandle, goal: &GoalRef) -> Result<(), GoalHostError> {
            GoalHost::clear(self.goals.as_ref(), session, goal)
        }
    }

    fn skewed(skew: fn(GoalView) -> GoalView) -> Harness {
        Harness::with(move |goals| Arc::new(Skewed { goals, skew }), true)
    }

    /// A host whose every call fails with one error.
    struct Failing(GoalHostError);

    impl GoalHost for Failing {
        fn get(&self, _session: &SessionHandle) -> Result<Option<GoalView>, GoalHostError> {
            Err(self.0.clone())
        }

        fn create(&self, _: &SessionHandle, _: &str) -> Result<GoalView, GoalHostError> {
            Err(self.0.clone())
        }

        fn edit(&self, _: &SessionHandle, _: &GoalRef, _: &str) -> Result<GoalView, GoalHostError> {
            Err(self.0.clone())
        }

        fn pause(&self, _: &SessionHandle, _: &GoalRef) -> Result<GoalView, GoalHostError> {
            Err(self.0.clone())
        }

        fn resume(&self, _: &SessionHandle, _: &GoalRef) -> Result<GoalView, GoalHostError> {
            Err(self.0.clone())
        }

        fn clear(&self, _: &SessionHandle, _: &GoalRef) -> Result<(), GoalHostError> {
            Err(self.0.clone())
        }
    }

    // ---- registration and the parse ----

    #[test]
    fn goal_registers_with_dsh_name_description_and_input_attachments_allowed() {
        let harness = Harness::new();
        let command = &harness.command;
        assert_eq!(command.name, "goal");
        assert_eq!(
            command.description,
            "Set or view the goal for a long-running task"
        );
        assert_eq!(
            command.input,
            Some(CommandInput {
                hint: "[<objective>|clear|edit <objective>|pause|resume]".to_owned(),
                attachments: Some(true),
            })
        );
        assert!(
            command.record_input,
            "the objective is recorded in command/run"
        );
        let registry = CommandRegistry::new();
        registry.register(command.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(registry.list()).unwrap(),
            json!([{
                "name": "goal",
                "label": "Goal",
                "description": "Set or view the goal for a long-running task",
                "section": "add",
                "input": {"hint": "[<objective>|clear|edit <objective>|pause|resume]", "attachments": true},
            }])
        );
        assert_eq!(
            serde_json::to_string(&registry.list()[0]).unwrap(),
            r#"{"name":"goal","label":"Goal","description":"Set or view the goal for a long-running task","section":"add","input":{"hint":"[<objective>|clear|edit <objective>|pause|resume]","attachments":true}}"#,
            "the TypeScript key order"
        );
    }

    #[test]
    fn the_parse_is_trimmed_empty_shows_controls_are_whole_words_in_any_case_edit_needs_whitespace_the_rest_creates()
     {
        let edit = |objective: &str| GoalCommand::Edit {
            objective: objective.to_owned(),
        };
        let create = |objective: &str| GoalCommand::Create {
            objective: objective.to_owned(),
        };
        let cases = [
            ("", GoalCommand::Show),
            ("  \n\t ", GoalCommand::Show),
            ("clear", GoalCommand::Clear),
            (" CLEAR ", GoalCommand::Clear),
            ("Pause", GoalCommand::Pause),
            ("rEsUmE", GoalCommand::Resume),
            ("edit", GoalCommand::InvalidEdit),
            ("  EDIT  ", GoalCommand::InvalidEdit),
            ("edit ship it", edit("ship it")),
            ("Edit\t  ship   it  ", edit("ship   it")),
            ("\nedit\nship it", edit("ship it")),
            ("editorial pass", create("editorial pass")),
            ("edit:ship", create("edit:ship")),
            (
                "pause after verification",
                create("pause after verification"),
            ),
            ("clear the cache", create("clear the cache")),
            ("  ship the parity table  ", create("ship the parity table")),
            ("ship it 5", create("ship it 5")),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_goal_command(input), expected, "{input:?}");
        }
        // The whitespace after `edit` is JavaScript's `\s`, which `String#trim` also removes.
        assert_eq!(parse_goal_command("edit\u{a0}ship"), edit("ship"));
        assert_eq!(parse_goal_command("edit\u{3000}ship"), edit("ship"));
        assert_eq!(
            parse_goal_command("edité"),
            create("edité"),
            "a letter after edit is not whitespace"
        );
    }

    // ---- show ----

    #[test]
    fn goal_with_no_goal_says_so_and_gives_the_usage() {
        let harness = Harness::new();
        let none = success(format!("No goal is currently set.\n{USAGE}"));
        assert_eq!(harness.run("/goal"), none);
        assert_eq!(harness.run("/goal   "), none);
        assert_eq!(harness.changes(), 0);
    }

    #[test]
    fn goal_shows_an_active_armed_goal_with_its_rounds_and_the_pause_hint() {
        let harness = Harness::new();
        let goal = harness.create_capped("ship the parity table", Some(5.0));
        harness.round_message(&goal, 1);
        assert_eq!(
            harness.run("/goal"),
            success(card(
                "Goal",
                "active",
                "ship the parity table",
                "1/5",
                "armed",
                HINT_ARMED
            ))
        );
    }

    #[test]
    fn goal_shows_an_active_but_disarmed_goal_with_the_resume_hint() {
        let harness = Harness::new();
        harness.create("o");
        harness.disarm();
        assert_eq!(
            harness.run("/goal"),
            success(card(
                "Goal",
                "active",
                "o",
                "0/100",
                "disarmed",
                HINT_STOPPED
            ))
        );
    }

    #[test]
    fn goal_shows_a_paused_goal_with_the_resume_hint() {
        let harness = Harness::new();
        let goal = harness.create("o");
        harness.pause(&goal.goal.goal_ref());
        assert_eq!(
            harness.run("/goal"),
            success(card(
                "Goal",
                "paused",
                "o",
                "0/100",
                "disarmed",
                HINT_STOPPED
            ))
        );
    }

    #[test]
    fn goal_shows_a_blocked_goal_with_its_blocker_line_code_then_message() {
        let harness = Harness::new();
        let goal = harness.create("o");
        harness.block(
            &goal.goal.goal_ref(),
            "model-reported",
            "the API key is missing",
        );
        assert_eq!(
            harness.run("/goal"),
            success(
                Card {
                    title: "Goal",
                    phase: "blocked",
                    blocker: Some("model-reported: the API key is missing"),
                    objective: "o",
                    rounds: "0/100",
                    activation: "disarmed",
                    hint: HINT_STOPPED,
                }
                .text()
            )
        );
    }

    #[test]
    fn goal_shows_a_complete_goal_with_the_create_hint() {
        let harness = Harness::new();
        let goal = harness.create("o");
        harness.complete(&goal.goal.goal_ref());
        assert_eq!(
            harness.run("/goal"),
            success(card(
                "Goal",
                "complete",
                "o",
                "0/100",
                "disarmed",
                HINT_COMPLETE
            ))
        );
    }

    // ---- create ----

    #[test]
    fn goal_objective_creates_the_goal_armed_at_once_with_the_whole_input_as_its_objective() {
        let harness = Harness::new();
        assert_eq!(
            harness.run("/goal   ship the parity table  "),
            success(card(
                "Goal created",
                "active",
                "ship the parity table",
                "0/100",
                "armed",
                HINT_ARMED
            ))
        );
        let current = harness.current().unwrap();
        assert_eq!(current.goal.objective, "ship the parity table");
        assert_eq!(current.activation, GoalActivation::Armed);
        assert_eq!(
            harness.changes(),
            1,
            "one goal/change, written by the goal service"
        );
    }

    #[test]
    fn goal_objective_while_a_goal_is_active_paused_or_blocked_is_refused_and_changes_nothing() {
        for phase in ["active", "paused", "blocked"] {
            let harness = Harness::new();
            let goal = harness.create("first");
            match phase {
                "paused" => {
                    harness.pause(&goal.goal.goal_ref());
                }
                "blocked" => {
                    harness.block(&goal.goal.goal_ref(), "model-reported", "stuck");
                }
                _ => {}
            }
            let before = harness.changes();
            assert_eq!(
                harness.run("/goal second"),
                error(format!(
                    "A goal is already {phase}. Use /goal edit <objective> to change it or /goal clear before replacing it."
                ))
            );
            assert_eq!(harness.changes(), before, "{phase}");
            assert_eq!(harness.current().unwrap().goal.objective, "first");
        }
    }

    #[test]
    fn goal_objective_over_a_complete_goal_replaces_it_with_a_new_armed_one() {
        let harness = Harness::new();
        let first = harness.create("first");
        harness.complete(&first.goal.goal_ref());
        assert_eq!(
            harness.run("/goal second"),
            success(card(
                "Goal created",
                "active",
                "second",
                "0/100",
                "armed",
                HINT_ARMED
            ))
        );
        assert_ne!(harness.current().unwrap().goal.id, first.goal.id);
    }

    #[test]
    fn goal_pause_after_verification_is_an_objective_not_a_pause() {
        let harness = Harness::new();
        assert_eq!(
            harness.run("/goal pause after verification"),
            success(card(
                "Goal created",
                "active",
                "pause after verification",
                "0/100",
                "armed",
                HINT_ARMED
            ))
        );
        assert_eq!(harness.current().unwrap().goal.phase, GoalPhase::Active);
        assert_eq!(
            harness.run("/goal clear the cache first"),
            error(
                "A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it."
            )
        );
        assert_eq!(
            harness.run("/goal editorial pass").kind(),
            "error",
            "\"editorial\" is not \"edit\": it is a create, refused while a goal is active"
        );
    }

    // ---- edit ----

    #[test]
    fn goal_edit_objective_replaces_the_objective_and_keeps_the_phase() {
        let harness = Harness::new();
        let goal = harness.create("first");
        assert_eq!(
            harness.run("/goal edit   second  "),
            success(card(
                "Goal updated",
                "active",
                "second",
                "0/100",
                "armed",
                HINT_ARMED
            ))
        );
        let current = harness.current().unwrap();
        assert_eq!(
            current.goal.id, goal.goal.id,
            "the same goal, a new revision"
        );
        assert_eq!(current.goal.revision, 2);
        harness.pause(&GoalRef {
            id: goal.goal.id.clone(),
            revision: 2,
        });
        assert_eq!(
            harness.run("/goal edit third"),
            success(card(
                "Goal updated",
                "paused",
                "third",
                "0/100",
                "disarmed",
                HINT_STOPPED
            ))
        );
    }

    #[test]
    fn goal_edit_with_no_objective_is_refused_with_or_without_a_goal() {
        let harness = Harness::new();
        let refusal = error(format!(
            "Goal editing requires a replacement objective.\n{USAGE}"
        ));
        assert_eq!(harness.run("/goal edit"), refusal);
        harness.create("o");
        assert_eq!(harness.run("/goal edit   "), refusal);
        assert_eq!(harness.changes(), 1);
    }

    #[test]
    fn goal_edit_on_a_complete_goal_creates_a_new_one() {
        let harness = Harness::new();
        let first = harness.create("first");
        harness.complete(&first.goal.goal_ref());
        assert_eq!(
            harness.run("/goal edit second"),
            success(card(
                "Goal created",
                "active",
                "second",
                "0/100",
                "armed",
                HINT_ARMED
            ))
        );
        let current = harness.current().unwrap();
        assert_ne!(current.goal.id, first.goal.id);
        assert_eq!(current.goal.revision, 1);
    }

    // ---- pause, resume, clear ----

    #[test]
    fn goal_pause_pauses_the_goal_and_disarms_it() {
        let harness = Harness::new();
        harness.create("o");
        assert_eq!(
            harness.run("/goal pause"),
            success(card(
                "Goal paused",
                "paused",
                "o",
                "0/100",
                "disarmed",
                HINT_STOPPED
            ))
        );
        assert_eq!(harness.current().unwrap().goal.phase, GoalPhase::Paused);
    }

    #[test]
    fn goal_resume_needs_no_authority_it_resumes_a_paused_a_disarmed_and_a_blocked_goal_and_arms_it()
     {
        let resumed = success(card(
            "Goal resumed",
            "active",
            "o",
            "0/100",
            "armed",
            HINT_ARMED,
        ));

        let paused = Harness::new();
        let goal = paused.create("o");
        paused.pause(&goal.goal.goal_ref());
        assert_eq!(
            paused.run("/goal resume"),
            resumed,
            "a person resumes what a person paused"
        );

        let disarmed = Harness::new();
        disarmed.create("o");
        disarmed.disarm();
        assert_eq!(disarmed.run("/goal resume"), resumed);

        let blocked = Harness::new();
        let goal = blocked.create("o");
        blocked.block(&goal.goal.goal_ref(), "model-reported", "stuck");
        assert_eq!(
            blocked.run("/goal resume"),
            resumed,
            "resuming drops the Blocker line"
        );
        assert_eq!(blocked.current().unwrap().goal.blocked_reason, None);
    }

    #[test]
    fn goal_clear_clears_the_goal_with_none_it_says_there_is_nothing_to_clear_and_writes_nothing() {
        let harness = Harness::new();
        assert_eq!(harness.run("/goal clear"), success("No goal to clear."));
        assert_eq!(harness.changes(), 0);
        harness.create("o");
        assert_eq!(harness.run("/goal clear"), success("Goal cleared."));
        assert_eq!(harness.current(), None);
        assert_eq!(harness.changes(), 2, "the create and the clear tombstone");
    }

    #[test]
    fn edit_pause_and_resume_with_no_goal_name_the_action_then_a_space_then_the_usage() {
        let harness = Harness::new();
        assert_eq!(
            harness.run("/goal edit ship it"),
            error(format!(
                "No goal is currently set; /goal edit requires one. {USAGE}"
            ))
        );
        assert_eq!(
            harness.run("/goal pause"),
            error(format!(
                "No goal is currently set; /goal pause requires one. {USAGE}"
            ))
        );
        assert_eq!(
            harness.run("/goal resume"),
            error(format!(
                "No goal is currently set; /goal resume requires one. {USAGE}"
            ))
        );
        assert_eq!(harness.changes(), 0);
    }

    #[test]
    fn the_controls_are_case_insensitive() {
        let harness = Harness::new();
        harness.create("o");
        assert!(text_of(&harness.run("/goal PAUSE")).starts_with("Goal paused\nStatus: paused\n"));
        assert!(
            text_of(&harness.run("/goal Resume")).starts_with("Goal resumed\nStatus: active\n")
        );
        assert!(
            text_of(&harness.run("/goal EDIT second"))
                .starts_with("Goal updated\nStatus: active\nObjective: second\n")
        );
        assert_eq!(
            harness.run("/goal Edit"),
            error(format!(
                "Goal editing requires a replacement objective.\n{USAGE}"
            ))
        );
        assert_eq!(harness.run("/goal CLEAR"), success("Goal cleared."));
        assert_eq!(harness.current(), None);
    }

    // ---- the goal service's refusals ----

    #[test]
    fn every_refusal_from_the_goal_service_is_dshs_one_generic_sentence() {
        // GOAL_INVALID_TRANSITION: resuming a goal that is already active and armed.
        let armed = Harness::new();
        armed.create("o");
        assert_eq!(armed.run("/goal resume"), error(STATE_ERROR));

        // GOAL_INVALID_TRANSITION: pausing a paused goal, and pausing a blocked one.
        let paused = Harness::new();
        let goal = paused.create("o");
        paused.pause(&goal.goal.goal_ref());
        assert_eq!(paused.run("/goal pause"), error(STATE_ERROR));
        let blocked = Harness::new();
        let goal = blocked.create("o");
        blocked.block(&goal.goal.goal_ref(), "model-reported", "stuck");
        assert_eq!(blocked.run("/goal pause"), error(STATE_ERROR));

        // GOAL_INVALID_TRANSITION: resuming a goal whose round cap is spent.
        let spent = Harness::new();
        let goal = spent.create_capped("o", Some(1.0));
        spent.round_message(&goal, 1);
        spent.pause(&goal.goal.goal_ref());
        assert_eq!(spent.run("/goal resume"), error(STATE_ERROR));

        // GOAL_INVALID_OBJECTIVE: an objective over the service's limit.
        let long = Harness::new();
        assert_eq!(
            long.run(&format!("/goal {}", "x".repeat(MAX_OBJECTIVE_LENGTH + 1))),
            error(STATE_ERROR)
        );
        assert_eq!(long.changes(), 0);
    }

    #[test]
    fn a_stale_read_and_a_vanished_goal_are_the_generic_sentence_too() {
        // GOAL_STALE_REVISION.
        let stale = skewed(|mut goal| {
            goal.goal.revision -= 1;
            goal
        });
        let goal = stale.create("o");
        stale.edit(&goal.goal.goal_ref(), "p");
        for line in ["/goal pause", "/goal edit q", "/goal clear"] {
            assert_eq!(stale.run(line), error(STATE_ERROR), "{line}");
        }

        // GOAL_NOT_FOUND.
        let vanished = skewed(|mut goal| {
            goal.goal.id = "goal-someone-else".to_owned();
            goal
        });
        vanished.create("o");
        assert_eq!(vanished.run("/goal pause"), error(STATE_ERROR));
    }

    #[tokio::test]
    async fn a_refusal_from_any_goal_host_is_recognised_and_any_other_failure_is_passed_on() {
        let foreign = Harness::with(
            |_| {
                Arc::new(Failing(GoalHostError::Refused {
                    code: GoalErrorCode::StaleRevision,
                    message: "stale goal ref".to_owned(),
                }))
            },
            true,
        );
        assert_eq!(foreign.run("/goal"), error(STATE_ERROR));

        let broken = Harness::with(
            |_| {
                Arc::new(Failing(GoalHostError::Failed(
                    "the goal service is not loaded in this profile".to_owned(),
                )))
            },
            true,
        );
        assert_eq!(
            broken.try_run("/goal", &[]),
            Err("the goal service is not loaded in this profile".to_owned())
        );
        let registry = CommandRegistry::new();
        registry.register(broken.command.clone()).unwrap();
        let execution = registry
            .execute(
                broken.fixture.log(),
                &broken.fixture.handle,
                "/goal pause",
                Vec::new(),
            )
            .await
            .unwrap()
            .expect("/goal is registered");
        assert_eq!(
            execution.result,
            error("the goal service is not loaded in this profile")
        );

        // The goal service's own split: a refusal is the goal domain's, a log failure is not.
        assert_eq!(
            GoalHostError::from(GoalError::Refused {
                code: GoalErrorCode::NotFound,
                message: "no goal goal-x is current".to_owned(),
            }),
            GoalHostError::Refused {
                code: GoalErrorCode::NotFound,
                message: "no goal goal-x is current".to_owned(),
            }
        );
        assert_eq!(
            GoalHostError::from(GoalError::Log(LogError("the disk is full".to_owned()))),
            GoalHostError::Failed("the disk is full".to_owned())
        );
    }

    #[test]
    fn a_blocked_goal_without_its_reason_cannot_be_shown_and_is_not_the_generic_sentence() {
        let harness = Harness::new();
        let mut goal = harness.create("o");
        goal.goal.phase = GoalPhase::Blocked;
        assert_eq!(
            render_goal("Goal", &goal),
            Err("blocked goal is missing its reason".to_owned())
        );
    }

    // ---- attachments ----

    #[test]
    fn attachments_on_a_form_that_sets_no_objective_are_refused_before_anything_is_read_or_written()
    {
        let harness = Harness::new();
        for line in [
            "/goal",
            "/goal clear",
            "/goal pause",
            "/goal resume",
            "/goal edit",
            "/goal EDIT  ",
        ] {
            assert_eq!(
                harness.run_with(line, &[file()]),
                error(ATTACHMENTS_REFUSED),
                "{line} with no goal"
            );
        }
        harness.create("o");
        for line in ["/goal", "/goal clear", "/goal Pause", "/goal resume"] {
            assert_eq!(
                harness.run_with(line, &[image(), file()]),
                error(ATTACHMENTS_REFUSED),
                "{line} with a goal"
            );
        }
        assert_eq!(
            harness.current().unwrap().goal.phase,
            GoalPhase::Active,
            "the refused pause did not pause"
        );
        assert_eq!(harness.changes(), 1);
        assert!(harness.followups().is_empty());
        assert_eq!(
            harness.run_with("/goal", &[]),
            success(card("Goal", "active", "o", "0/100", "armed", HINT_ARMED)),
            "an empty list is no attachments"
        );
        // Refused before anything is read: a host that fails every call is never asked.
        let failing = Harness::with(
            |_| Arc::new(Failing(GoalHostError::Failed("not asked".to_owned()))),
            true,
        );
        assert_eq!(
            failing.run_with("/goal pause", &[file()]),
            error(ATTACHMENTS_REFUSED)
        );
    }

    #[test]
    fn attachments_on_a_create_go_on_after_the_goal_is_set_as_one_follow_up_message_from_the_person()
     {
        let harness = Harness::new();
        assert_eq!(
            harness.run_with("/goal ship the parity table", &[image(), file()]),
            success(card(
                "Goal created",
                "active",
                "ship the parity table",
                "0/100",
                "armed",
                HINT_ARMED
            ))
        );
        assert_eq!(
            harness.current().unwrap().goal.objective,
            "ship the parity table",
            "the objective is the text alone"
        );
        let followups = harness.followups();
        assert_eq!(followups.len(), 1);
        let (session, message) = &followups[0];
        assert_eq!(session, &harness.fixture.handle);
        assert_eq!(
            message,
            &Message {
                role: Role::User,
                tool_call_id: None,
                content: vec![image(), file(), attachments_text()],
                source: Some(json!({"kind": "user"})),
            }
        );
        // As the TypeScript `GoalFollowup` serialises.
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            json!({
                "role": "user",
                "content": [
                    {"type": "image", "name": "plan.png", "mimeType": "image/png", "path": "/uploads/plan.png", "bytes": 10, "sha256": "sha256:aa"},
                    {"type": "file", "name": "spec.md", "path": "/uploads/spec.md", "bytes": 34, "sha256": "sha256:bb"},
                    {"type": "text", "text": "Reference attachments for the goal objective."},
                ],
                "source": {"kind": "user"},
            })
        );
    }

    #[test]
    fn attachments_on_an_edit_and_on_an_edit_that_replaces_a_complete_goal_follow_up_the_same_way()
    {
        let harness = Harness::new();
        let goal = harness.create("first");
        assert!(
            text_of(&harness.run_with("/goal edit second", &[file()]))
                .starts_with("Goal updated\n")
        );
        harness.complete(&GoalRef {
            id: goal.goal.id.clone(),
            revision: 2,
        });
        assert!(
            text_of(&harness.run_with("/goal edit third", &[image()]))
                .starts_with("Goal created\n")
        );
        let contents: Vec<Vec<ContentPart>> = harness
            .followups()
            .into_iter()
            .map(|(_, message)| message.content)
            .collect();
        assert_eq!(
            contents,
            vec![
                vec![file(), attachments_text()],
                vec![image(), attachments_text()],
            ]
        );
    }

    #[test]
    fn no_follow_up_without_attachments_or_when_the_create_or_edit_itself_is_refused() {
        let harness = Harness::new();
        harness.run("/goal first");
        harness.run("/goal edit second");
        assert!(harness.followups().is_empty(), "no attachments, no message");
        assert_eq!(
            harness.run_with("/goal another", &[file()]).kind(),
            "error",
            "a goal is already active"
        );
        let stale = skewed(|mut goal| {
            goal.goal.revision += 1;
            goal
        });
        stale.create("o");
        assert_eq!(
            stale.run_with("/goal edit p", &[file()]),
            error(STATE_ERROR)
        );
        assert!(
            harness.followups().is_empty() && stale.followups().is_empty(),
            "a refused change carries nothing on"
        );
    }

    #[test]
    fn without_a_follow_up_sink_a_create_with_attachments_still_sets_the_goal() {
        let harness = Harness::with(|goals| goals, false);
        assert!(
            text_of(&harness.run_with("/goal ship it", &[file()])).starts_with("Goal created\n")
        );
        assert_eq!(harness.current().unwrap().goal.objective, "ship it");
        assert!(harness.followups().is_empty());
        // With no sink the page delivers the follow-up: the result asks it to send DSH's text with the files.
        let edited = harness.run_with("/goal edit ship it twice", &[file()]);
        assert_eq!(
            edited.action(),
            Some(&CommandAction::Prompt {
                text: GOAL_ATTACHMENTS_TEXT.to_owned()
            })
        );
        assert_eq!(
            harness.run("/goal").action(),
            None,
            "only a create or an edit with files carries it on"
        );
    }

    #[test]
    fn the_follow_up_message_is_none_without_attachments() {
        assert_eq!(goal_attachment_followup(&[]), None);
        let message = goal_attachment_followup(&[file()]).unwrap();
        assert_eq!(
            serde_json::to_value(&message).unwrap()["source"],
            json!({"kind": "user"})
        );
    }

    // ---- attachments through the layer's own context ----

    /// A registry holding only the harness's `/goal`, and the run the layer performs for a line and its files.
    async fn execute_through_the_layer(
        harness: &Harness,
        registry: &CommandRegistry,
        line: &str,
        attachments: Vec<ContentPart>,
    ) -> CommandResult {
        registry
            .execute(
                harness.fixture.log(),
                &harness.fixture.handle,
                line,
                attachments,
            )
            .await
            .expect("the log takes the run")
            .unwrap_or_else(|| panic!("{line} is /goal"))
            .result
    }

    #[tokio::test]
    async fn the_layer_hands_goal_the_lines_files_and_every_form_that_sets_no_objective_refuses_them()
     {
        let harness = Harness::new();
        let registry = CommandRegistry::new();
        registry.register(harness.command.clone()).unwrap();
        for line in [
            "/goal",
            "/goal clear",
            "/goal pause",
            "/goal resume",
            "/goal edit",
        ] {
            assert_eq!(
                execute_through_the_layer(&harness, &registry, line, vec![file()]).await,
                error(ATTACHMENTS_REFUSED),
                "{line} with no goal"
            );
        }
        harness.create("o");
        for line in ["/goal", "/goal clear", "/goal pause", "/goal resume"] {
            assert_eq!(
                execute_through_the_layer(&harness, &registry, line, vec![image(), file()]).await,
                error(ATTACHMENTS_REFUSED),
                "{line} with a goal"
            );
        }
        let current = harness.current().unwrap();
        assert_eq!(
            current.goal.phase,
            GoalPhase::Active,
            "the refused pause did not pause"
        );
        assert_eq!(
            current.goal.objective, "o",
            "the refused clear did not clear"
        );
        assert_eq!(
            harness.changes(),
            1,
            "only the direct create wrote a goal change"
        );
        assert!(harness.followups().is_empty());
        // `/goal` accepts attachments, so the layer ran it and recorded `/goal`'s own refusal, not the layer's.
        let done: Vec<_> = harness
            .fixture
            .events()
            .iter()
            .filter(|event| event.kind == crate::registry::COMMAND_DONE_EVENT)
            .map(|event| (event.get("kind").cloned(), event.get("text").cloned()))
            .collect();
        assert_eq!(done.len(), 9);
        assert!(
            done.iter()
                .all(|entry| *entry == (Some(json!("error")), Some(json!(ATTACHMENTS_REFUSED))))
        );
    }

    #[tokio::test]
    async fn the_layer_hands_goal_the_lines_files_and_a_create_takes_them_on_as_one_follow_up_message()
     {
        let harness = Harness::new();
        let registry = CommandRegistry::new();
        registry.register(harness.command.clone()).unwrap();
        assert_eq!(
            execute_through_the_layer(
                &harness,
                &registry,
                "/goal ship the release",
                vec![image(), file()]
            )
            .await,
            success(card(
                "Goal created",
                "active",
                "ship the release",
                "0/100",
                "armed",
                HINT_ARMED
            ))
        );
        assert_eq!(
            harness.current().unwrap().goal.objective,
            "ship the release",
            "the objective is the text alone"
        );
        assert_eq!(
            harness.followups(),
            vec![(
                harness.fixture.handle.clone(),
                Message {
                    role: Role::User,
                    tool_call_id: None,
                    content: vec![image(), file(), attachments_text()],
                    source: Some(json!({"kind": "user"})),
                }
            )]
        );
        assert!(
            text_of(
                &execute_through_the_layer(
                    &harness,
                    &registry,
                    "/goal edit ship it twice",
                    vec![file()]
                )
                .await
            )
            .starts_with("Goal updated\n")
        );
        assert_eq!(
            harness.followups().len(),
            2,
            "an edit takes its files on too"
        );
        execute_through_the_layer(&harness, &registry, "/goal edit ship it thrice", Vec::new())
            .await;
        assert_eq!(
            harness.followups().len(),
            2,
            "a line without files carries nothing on"
        );
    }
}
