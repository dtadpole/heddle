//! The built-in host commands, with DSH's names, descriptions, argument forms and sentences.
//!
//! Ported from `src/commands/builtins.ts`. Each is a factory over the smallest host it needs, so a command is
//! judged against a double and wired to the real services in one place ([`crate::service`]). The words a
//! person reads are DSH's, re-read from its source on 2026-10-29; where heddle has no equivalent fact (a ZIP
//! archive, an approval preset) the sentence says what heddle does instead.

use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use heddle_sandbox::SandboxMode;
use heddle_session::{NewEvent, SessionHandle};

use crate::registry::{
    CommandAction, CommandDefinition, CommandInput, CommandLog, CommandResult, CommandSection,
};
use crate::text;

/// A goal reference, as the goal service takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalRefLike {
    /// The goal.
    pub id: String,
    /// The revision a change is compared against.
    pub revision: u64,
}

/// A goal, as the goal service shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalLike {
    /// The goal.
    pub id: String,
    /// Its revision.
    pub revision: u64,
    /// What completes it.
    pub objective: String,
    /// `active`, `paused`, `blocked` or `complete`.
    pub phase: String,
    /// The round cap.
    pub max_goal_rounds: u64,
    /// The rounds admitted so far, when known.
    pub rounds_started: Option<u64>,
    /// `armed` or `disarmed`, when known.
    pub activation: Option<String>,
}

impl GoalLike {
    /// The reference a change of this goal names.
    pub fn goal_ref(&self) -> GoalRefLike {
        GoalRefLike {
            id: self.id.clone(),
            revision: self.revision,
        }
    }
}

/// The goal operations `/goal` drives: the goal service's own methods. An `Err` is the service's sentence.
pub trait GoalHost: Send + Sync {
    /// The current goal, if any.
    fn get(&self, session: &SessionHandle) -> Result<Option<GoalLike>, String>;
    /// Create a goal with this objective.
    fn create(&self, session: &SessionHandle, objective: &str) -> Result<GoalLike, String>;
    /// Replace the objective.
    fn edit(
        &self,
        session: &SessionHandle,
        goal: &GoalRefLike,
        objective: &str,
    ) -> Result<GoalLike, String>;
    /// Pause it.
    fn pause(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<GoalLike, String>;
    /// Resume it.
    fn resume(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<GoalLike, String>;
    /// Clear it.
    fn clear(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<(), String>;
}

/// `/goal` — set, show, edit, pause, resume or clear the session's goal.
///
/// DSH's argument forms: nothing shows the goal; `clear`, `pause` and `resume` (any case) act on it;
/// `edit <objective>` replaces its objective; any other text creates one, which is refused while an unfinished
/// goal exists.
pub fn goal_command(goals: Arc<dyn GoalHost>) -> CommandDefinition {
    CommandDefinition::sync(
        "goal",
        "Set or view the goal for a long-running task",
        move |context| {
            let session = &context.session;
            let args = context.args.as_str();
            let current = goals.get(session)?;
            let word = args.to_lowercase();
            if args.is_empty() {
                return Ok(match current {
                    None => CommandResult::success_text(
                        "No goal is set. Use /goal <objective> to set one.",
                    ),
                    Some(goal) => CommandResult::success_text(describe_goal(&goal)),
                });
            }
            if matches!(word.as_str(), "clear" | "pause" | "resume") {
                let Some(current) = current else {
                    return Ok(CommandResult::error(format!("There is no goal to {word}.")));
                };
                let reference = current.goal_ref();
                return Ok(match word.as_str() {
                    "clear" => {
                        goals.clear(session, &reference)?;
                        CommandResult::success_text("Goal cleared.")
                    }
                    "pause" => {
                        goals.pause(session, &reference)?;
                        CommandResult::success_text("Goal paused.")
                    }
                    _ => {
                        goals.resume(session, &reference)?;
                        CommandResult::success_text("Goal resumed.")
                    }
                });
            }
            if word == "edit"
                || word.starts_with("edit ")
                || word.starts_with("edit\t")
                || word.starts_with("edit\n")
            {
                // `args.slice(4)`: the four characters `word` starts with are ASCII in `args` as well.
                let objective = text::trim(args.get(4..).unwrap_or(""));
                if objective.is_empty() {
                    return Ok(CommandResult::error("Usage: /goal edit <objective>"));
                }
                let Some(current) = current else {
                    return Ok(CommandResult::error(
                        "There is no goal to edit. Use /goal <objective> to set one.",
                    ));
                };
                let edited = goals.edit(session, &current.goal_ref(), objective)?;
                return Ok(CommandResult::success_text(format!(
                    "Goal updated: {}",
                    edited.objective
                )));
            }
            if let Some(current) = &current
                && current.phase != "complete"
            {
                return Ok(CommandResult::error(format!(
                    "A goal is already {}. Use /goal edit <objective> to change it, or /goal clear to remove it.",
                    current.phase
                )));
            }
            let created = goals.create(session, args)?;
            Ok(CommandResult::success_text(format!(
                "Goal set: {}",
                created.objective
            )))
        },
    )
    .label("Goal")
    .section(CommandSection::Add)
    .input(CommandInput::hint(
        "[<objective>|clear|edit <objective>|pause|resume]",
    ))
}

/// The goal as `/goal` shows it: DSH's status, objective, rounds, activation and commands lines.
pub fn describe_goal(goal: &GoalLike) -> String {
    let mut lines = vec![
        format!("Status: {}", goal.phase),
        format!("Objective: {}", goal.objective),
        format!(
            "Rounds: {}/{}",
            goal.rounds_started.unwrap_or(0),
            goal.max_goal_rounds
        ),
    ];
    if let Some(activation) = &goal.activation {
        lines.push(format!("Activation: {activation}"));
    }
    lines.push(
        "Commands: /goal edit <objective> · /goal pause · /goal resume · /goal clear".to_owned(),
    );
    lines.join("\n")
}

/// What a manual compaction reports.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompactionOutcome {
    /// Whether a summary landed.
    pub compacted: bool,
    /// How many history items the summary replaced.
    pub items: Option<u64>,
    /// Roughly how many tokens the replaced items held.
    pub tokens: Option<u64>,
    /// The summary's sequence number in the session log.
    pub summary_seq: Option<u64>,
}

/// The compaction `/compact` asks for: summarise the session's older history now. An `Err` is the sentence
/// naming why it could not.
pub trait CompactionHost: Send + Sync {
    /// Compact now.
    fn compact_now<'a>(
        &'a self,
        session: &'a SessionHandle,
    ) -> BoxFuture<'a, Result<CompactionOutcome, String>>;
}

/// `/compact` — compact older history now. It takes no arguments.
pub fn compact_command(host: Arc<dyn CompactionHost>) -> CommandDefinition {
    CommandDefinition::new(
        "compact",
        "Compact older conversation history",
        move |context| {
            let host = Arc::clone(&host);
            async move {
                if !context.args.is_empty() {
                    return Ok(CommandResult::error("Usage: /compact (no arguments)"));
                }
                let outcome = host.compact_now(&context.session).await?;
                if !outcome.compacted {
                    return Ok(CommandResult::success_text("No compactable history yet."));
                }
                let items = match outcome.items {
                    Some(items) => format!("{items} history items"),
                    None => "older history".to_owned(),
                };
                let tokens = match outcome.tokens {
                    Some(tokens) => format!(" (~{tokens} tokens)"),
                    None => String::new(),
                };
                let result = CommandResult::success_text(format!("Compacted {items}{tokens}."));
                Ok(match outcome.summary_seq {
                    Some(seq) => result.with_source_event_seq(seq),
                    None => result,
                })
            }
            .boxed()
        },
    )
    .label("Compact")
    .section(CommandSection::Commands)
}

/// The log event `/feedback` appends.
pub const FEEDBACK_EVENT: &str = "feedback/record";

/// Where `/feedback`'s anonymous id comes from; an `Err` is why it could not be read or made.
pub type AnonymousUser = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;

/// `/feedback <text>` — record feedback about this session in its log. The text is not repeated in
/// `command/run`.
pub fn feedback_command(
    log: Arc<dyn CommandLog>,
    anonymous_user: AnonymousUser,
) -> CommandDefinition {
    CommandDefinition::sync(
        "feedback",
        "Record feedback about this session",
        move |context| {
            if context.args.is_empty() {
                return Ok(CommandResult::error(
                    "Feedback text is required. Usage: /feedback <text>",
                ));
            }
            let user = anonymous_user()?;
            log.append_event(
                &context.session,
                NewEvent::new(FEEDBACK_EVENT)
                    .field("text", context.args.clone())
                    .field("anonymousUser", user.clone()),
            )?;
            Ok(CommandResult::success_text(format!(
                "Feedback recorded for session {}\nAnonymous user: {user}.",
                context.session.id
            )))
        },
    )
    .label("Feedback")
    .section(CommandSection::Add)
    .input(CommandInput::hint("<text>"))
    .record_input(false)
}

/// The session's access mode, read and written as the access chip does. An `Err` is the session's sentence.
pub trait PermissionHost: Send + Sync {
    /// The mode the session runs under now.
    fn current(&self, session: &SessionHandle) -> Result<SandboxMode, String>;
    /// Record a new mode; answers whether anything changed.
    fn set(&self, session: &SessionHandle, mode: SandboxMode) -> Result<bool, String>;
}

/// `/permission <preset>` — switch the session's access mode.
///
/// heddle's presets are its three sandbox modes. Widening to `danger-full-access` is the one change the access
/// chip guards with a risk gate, and a typed line cannot acknowledge one, so the command refuses it and names
/// the chip.
pub fn permission_command(host: Arc<dyn PermissionHost>) -> CommandDefinition {
    let available = SandboxMode::ALL
        .iter()
        .map(|mode| mode.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    CommandDefinition::sync(
        "permission",
        "Switch the permission preset (sandbox mode + approval policy)",
        move |context| {
            let current = host.current(&context.session)?;
            let args = context.args.as_str();
            if args.is_empty() {
                return Ok(CommandResult::success_text(format!(
                    "current preset {current} (available: {available})"
                )));
            }
            let Some(mode) = SandboxMode::parse(args) else {
                return Ok(CommandResult::error(format!(
                    "unknown preset \"{args}\" (available: {available})"
                )));
            };
            if mode == SandboxMode::DangerFullAccess && mode.rank() > current.rank() {
                return Ok(CommandResult::error(
                    "widening to 'danger-full-access' needs the risk gate: choose it from the access control in the composer",
                ));
            }
            host.set(&context.session, mode)?;
            Ok(CommandResult::success_text(format!("preset {mode}")))
        },
    )
    .label("Permission")
    .section(CommandSection::Commands)
    .input(CommandInput::hint("<preset>"))
}

/// `/export` — download this session's log, the same bytes as Download log. It takes no path.
pub fn export_command() -> CommandDefinition {
    CommandDefinition::sync("export", "Download this session log", |context| {
        if !context.args.is_empty() {
            return Ok(CommandResult::error(
                "The Web /export command does not accept a path.",
            ));
        }
        Ok(
            CommandResult::success_text("Session log download requested.").with_action(
                CommandAction::Download {
                    href: format!(
                        "/api/sessions/{}/log",
                        text::encode_uri_component(&context.session.id)
                    ),
                },
            ),
        )
    })
    .label("Export")
    .section(CommandSection::Commands)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use heddle_goal::{GoalConfig, GoalService};
    use heddle_session::SessionEvent;
    use serde_json::json;

    use super::*;
    use crate::registry::{COMMAND_RUN_EVENT, CommandRegistry};
    use crate::test_support::Fixture;

    /// Run one line and answer its result.
    async fn run(registry: &CommandRegistry, fixture: &Fixture, line: &str) -> CommandResult {
        registry
            .execute(fixture.log(), &fixture.handle, line, Vec::new())
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("{line} is a registered command"))
            .result
    }

    fn success(text: &str) -> CommandResult {
        CommandResult::success_text(text)
    }

    fn error(text: &str) -> CommandResult {
        CommandResult::error(text)
    }

    #[tokio::test]
    async fn goal_sets_shows_edits_pauses_resumes_and_clears_the_goal_through_the_goal_service() {
        let fixture = Fixture::new("goal");
        let goals = Arc::new(GoalService::new(
            fixture.store.clone(),
            GoalConfig::default(),
        ));
        let registry = CommandRegistry::new();
        registry
            .register(goal_command(goals.clone() as Arc<dyn GoalHost>))
            .unwrap();
        let session = fixture.handle.id.clone();
        let objective = || goals.get(&session).unwrap().map(|view| view.goal.objective);
        let phase = || {
            goals
                .get(&session)
                .unwrap()
                .map(|view| view.goal.phase.as_str())
        };

        assert_eq!(
            run(&registry, &fixture, "/goal").await,
            success("No goal is set. Use /goal <objective> to set one.")
        );
        assert_eq!(
            run(&registry, &fixture, "/goal ship the parity table").await,
            success("Goal set: ship the parity table")
        );
        assert_eq!(objective().as_deref(), Some("ship the parity table"));
        assert_eq!(
            run(&registry, &fixture, "/goal something else").await,
            error(
                "A goal is already active. Use /goal edit <objective> to change it, or /goal clear to remove it."
            )
        );
        let shown = run(&registry, &fixture, "/goal").await;
        assert_eq!(shown.kind(), "success");
        let shown = shown.text().unwrap().to_owned();
        let lines: Vec<&str> = shown.lines().collect();
        assert_eq!(lines[0], "Status: active");
        assert_eq!(lines[1], "Objective: ship the parity table");
        let rounds = lines[2].strip_prefix("Rounds: 0/").expect("rounds line");
        assert!(rounds.parse::<u64>().is_ok(), "{shown}");
        assert!(
            matches!(lines[3], "Activation: armed" | "Activation: disarmed"),
            "{shown}"
        );
        assert!(lines[4].starts_with("Commands: "), "{shown}");
        assert_eq!(
            run(&registry, &fixture, "/goal edit").await,
            error("Usage: /goal edit <objective>")
        );
        assert_eq!(
            run(&registry, &fixture, "/goal edit ship it twice").await,
            success("Goal updated: ship it twice")
        );
        assert_eq!(
            run(&registry, &fixture, "/goal PAUSE").await,
            success("Goal paused."),
            "the words are case-insensitive"
        );
        assert_eq!(phase(), Some("paused"));
        assert_eq!(
            run(&registry, &fixture, "/goal resume").await,
            success("Goal resumed.")
        );
        assert_eq!(phase(), Some("active"));
        assert_eq!(
            run(&registry, &fixture, "/goal clear").await,
            success("Goal cleared.")
        );
        assert_eq!(objective(), None);
        assert_eq!(
            run(&registry, &fixture, "/goal pause").await,
            error("There is no goal to pause.")
        );
        assert_eq!(
            run(&registry, &fixture, "/goal edit x").await,
            error("There is no goal to edit. Use /goal <objective> to set one.")
        );
        assert!(
            fixture
                .events()
                .iter()
                .any(|event| event.kind == "goal/change"),
            "the goal service wrote its own events"
        );
    }

    #[tokio::test]
    async fn a_goal_service_refusal_is_the_runs_error() {
        let fixture = Fixture::new("goal-refusal");
        let goals = Arc::new(GoalService::new(
            fixture.store.clone(),
            GoalConfig::default(),
        ));
        let registry = CommandRegistry::new();
        registry.register(goal_command(goals)).unwrap();
        let long = "x".repeat(heddle_goal::MAX_OBJECTIVE_LENGTH + 1);
        let refused = run(&registry, &fixture, &format!("/goal {long}")).await;
        assert_eq!(refused.kind(), "error");
        assert!(!refused.text().unwrap().is_empty());
    }

    #[test]
    fn a_goal_is_described_with_its_status_objective_rounds_activation_and_commands() {
        let goal = GoalLike {
            id: "g".to_owned(),
            revision: 1,
            objective: "o".to_owned(),
            phase: "paused".to_owned(),
            max_goal_rounds: 9,
            rounds_started: Some(2),
            activation: None,
        };
        assert_eq!(
            describe_goal(&goal),
            "Status: paused\nObjective: o\nRounds: 2/9\nCommands: /goal edit <objective> · /goal pause · /goal resume · /goal clear"
        );
        let armed = GoalLike {
            rounds_started: None,
            activation: Some("armed".to_owned()),
            ..goal
        };
        assert_eq!(
            describe_goal(&armed),
            "Status: paused\nObjective: o\nRounds: 0/9\nActivation: armed\nCommands: /goal edit <objective> · /goal pause · /goal resume · /goal clear"
        );
    }

    /// A compaction that answers the outcomes it was given, in order, and counts its calls.
    struct Outcomes {
        outcomes: Mutex<Vec<Result<CompactionOutcome, String>>>,
        calls: AtomicUsize,
    }

    impl CompactionHost for Outcomes {
        fn compact_now<'a>(
            &'a self,
            _session: &'a SessionHandle,
        ) -> BoxFuture<'a, Result<CompactionOutcome, String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut outcomes = self.outcomes.lock().unwrap();
            let next = if outcomes.is_empty() {
                Ok(CompactionOutcome::default())
            } else {
                outcomes.remove(0)
            };
            futures::future::ready(next).boxed()
        }
    }

    #[tokio::test]
    async fn compact_takes_no_arguments_reports_what_it_compacted_and_says_when_there_was_nothing()
    {
        let fixture = Fixture::new("compact");
        let host = Arc::new(Outcomes {
            outcomes: Mutex::new(vec![
                Ok(CompactionOutcome {
                    compacted: true,
                    items: Some(12),
                    tokens: Some(3400),
                    summary_seq: Some(7),
                }),
                Ok(CompactionOutcome::default()),
                Ok(CompactionOutcome {
                    compacted: true,
                    ..CompactionOutcome::default()
                }),
            ]),
            calls: AtomicUsize::new(0),
        });
        let registry = CommandRegistry::new();
        registry.register(compact_command(host.clone())).unwrap();
        assert_eq!(
            run(&registry, &fixture, "/compact now").await,
            error("Usage: /compact (no arguments)")
        );
        assert_eq!(
            host.calls.load(Ordering::SeqCst),
            0,
            "an argument is refused before anything is compacted"
        );
        assert_eq!(
            run(&registry, &fixture, "/compact").await,
            success("Compacted 12 history items (~3400 tokens).").with_source_event_seq(7)
        );
        assert_eq!(
            run(&registry, &fixture, "/compact").await,
            success("No compactable history yet.")
        );
        assert_eq!(
            run(&registry, &fixture, "/compact").await,
            success("Compacted older history.")
        );
    }

    #[tokio::test]
    async fn compact_passes_a_compaction_failure_on_as_the_run_error() {
        let fixture = Fixture::new("compact-failure");
        let host = Arc::new(Outcomes {
            outcomes: Mutex::new(vec![Err(
                "Compaction is unavailable because the context service is not loaded.".to_owned(),
            )]),
            calls: AtomicUsize::new(0),
        });
        let registry = CommandRegistry::new();
        registry.register(compact_command(host)).unwrap();
        assert_eq!(
            run(&registry, &fixture, "/compact").await,
            error("Compaction is unavailable because the context service is not loaded.")
        );
    }

    #[tokio::test]
    async fn feedback_records_the_text_in_its_own_event_keeps_it_out_of_command_run_and_needs_text()
    {
        let fixture = Fixture::new("feedback");
        let registry = CommandRegistry::new();
        registry
            .register(feedback_command(
                fixture.store.clone(),
                Arc::new(|| Ok("00000000-0000-4000-8000-000000000000".to_owned())),
            ))
            .unwrap();
        assert_eq!(
            run(&registry, &fixture, "/feedback").await,
            error("Feedback text is required. Usage: /feedback <text>")
        );
        assert_eq!(
            run(&registry, &fixture, "/feedback the menu is lovely").await,
            success(&format!(
                "Feedback recorded for session {}\nAnonymous user: 00000000-0000-4000-8000-000000000000.",
                fixture.handle.id
            ))
        );
        let events = fixture.events();
        let feedback: Vec<&Arc<SessionEvent>> = events
            .iter()
            .filter(|event| event.kind == FEEDBACK_EVENT)
            .collect();
        assert_eq!(feedback.len(), 1);
        assert_eq!(feedback[0].get("text"), Some(&json!("the menu is lovely")));
        assert_eq!(
            feedback[0].get("anonymousUser"),
            Some(&json!("00000000-0000-4000-8000-000000000000"))
        );
        let runs: Vec<&Arc<SessionEvent>> = events
            .iter()
            .filter(|event| event.kind == COMMAND_RUN_EVENT)
            .collect();
        assert_eq!(runs.len(), 2);
        assert!(
            runs.iter().all(|event| event.get("args").is_none()),
            "record_input(false) keeps the text out of command/run"
        );
    }

    #[tokio::test]
    async fn feedback_without_an_anonymous_id_is_the_runs_error() {
        let fixture = Fixture::new("feedback-failure");
        let registry = CommandRegistry::new();
        registry
            .register(feedback_command(
                fixture.store.clone(),
                Arc::new(|| Err("the heddle home is read-only".to_owned())),
            ))
            .unwrap();
        assert_eq!(
            run(&registry, &fixture, "/feedback hello").await,
            error("the heddle home is read-only")
        );
        assert!(
            !fixture
                .events()
                .iter()
                .any(|event| event.kind == FEEDBACK_EVENT)
        );
    }

    /// The access mode in memory, with every write recorded.
    struct Modes {
        mode: Mutex<SandboxMode>,
        writes: Mutex<Vec<SandboxMode>>,
    }

    impl PermissionHost for Modes {
        fn current(&self, _session: &SessionHandle) -> Result<SandboxMode, String> {
            Ok(*self.mode.lock().unwrap())
        }

        fn set(&self, _session: &SessionHandle, mode: SandboxMode) -> Result<bool, String> {
            self.writes.lock().unwrap().push(mode);
            let mut current = self.mode.lock().unwrap();
            let changed = *current != mode;
            *current = mode;
            Ok(changed)
        }
    }

    #[tokio::test]
    async fn permission_shows_refuses_an_unknown_preset_narrows_freely_and_leaves_widening_to_the_chip()
     {
        let fixture = Fixture::new("permission");
        let host = Arc::new(Modes {
            mode: Mutex::new(SandboxMode::WorkspaceWrite),
            writes: Mutex::new(Vec::new()),
        });
        let registry = CommandRegistry::new();
        registry.register(permission_command(host.clone())).unwrap();
        let available = "read-only, workspace-write, danger-full-access";
        assert_eq!(
            run(&registry, &fixture, "/permission").await,
            success(&format!(
                "current preset workspace-write (available: {available})"
            ))
        );
        assert_eq!(
            run(&registry, &fixture, "/permission root").await,
            error(&format!("unknown preset \"root\" (available: {available})"))
        );
        assert_eq!(
            run(&registry, &fixture, "/permission danger-full-access").await,
            error(
                "widening to 'danger-full-access' needs the risk gate: choose it from the access control in the composer"
            )
        );
        assert!(
            host.writes.lock().unwrap().is_empty(),
            "nothing was written for a refusal"
        );
        assert_eq!(
            run(&registry, &fixture, "/permission read-only").await,
            success("preset read-only")
        );
        assert_eq!(
            run(&registry, &fixture, "/permission workspace-write").await,
            success("preset workspace-write")
        );
        assert_eq!(
            *host.writes.lock().unwrap(),
            [SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite]
        );
        *host.mode.lock().unwrap() = SandboxMode::DangerFullAccess;
        assert_eq!(
            run(&registry, &fixture, "/permission danger-full-access").await,
            success("preset danger-full-access"),
            "not a widening when already there"
        );
        assert_eq!(
            run(&registry, &fixture, "/permission Read-Only").await,
            error(&format!(
                "unknown preset \"Read-Only\" (available: {available})"
            )),
            "a preset is matched exactly"
        );
    }

    #[tokio::test]
    async fn export_asks_the_page_to_download_the_same_bytes_as_download_log_and_refuses_a_path() {
        let fixture = Fixture::new("export");
        let registry = CommandRegistry::new();
        registry.register(export_command()).unwrap();
        assert_eq!(
            run(&registry, &fixture, "/export /tmp/x.zip").await,
            error("The Web /export command does not accept a path.")
        );
        assert_eq!(
            run(&registry, &fixture, "/export").await,
            success("Session log download requested.").with_action(CommandAction::Download {
                href: format!("/api/sessions/{}/log", fixture.handle.id)
            })
        );
    }

    /// A log that must never be written to.
    struct Unwritten;

    impl CommandLog for Unwritten {
        fn append_event(
            &self,
            _session: &SessionHandle,
            _event: NewEvent,
        ) -> Result<Arc<SessionEvent>, String> {
            panic!("not called")
        }
    }

    #[test]
    fn the_built_in_commands_carry_dsh_names_descriptions_inputs_and_menu_sections() {
        let fixture = Fixture::new("listing");
        let registry = CommandRegistry::new();
        let goals = Arc::new(GoalService::new(
            fixture.store.clone(),
            GoalConfig::default(),
        ));
        registry.register(goal_command(goals)).unwrap();
        registry
            .register(compact_command(Arc::new(Outcomes {
                outcomes: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
            })))
            .unwrap();
        registry
            .register(feedback_command(
                Arc::new(Unwritten),
                Arc::new(|| Ok("u".to_owned())),
            ))
            .unwrap();
        registry
            .register(permission_command(Arc::new(Modes {
                mode: Mutex::new(SandboxMode::ReadOnly),
                writes: Mutex::new(Vec::new()),
            })))
            .unwrap();
        registry.register(export_command()).unwrap();
        let listed: Vec<(String, String, String, Option<String>, String)> = registry
            .list()
            .into_iter()
            .map(|entry| {
                (
                    entry.name,
                    entry.label,
                    serde_json::to_value(entry.section)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    entry.input.map(|input| input.hint),
                    entry.description,
                )
            })
            .collect();
        let row =
            |name: &str, label: &str, section: &str, hint: Option<&str>, description: &str| {
                (
                    name.to_owned(),
                    label.to_owned(),
                    section.to_owned(),
                    hint.map(str::to_owned),
                    description.to_owned(),
                )
            };
        assert_eq!(
            listed,
            vec![
                row(
                    "compact",
                    "Compact",
                    "commands",
                    None,
                    "Compact older conversation history"
                ),
                row(
                    "export",
                    "Export",
                    "commands",
                    None,
                    "Download this session log"
                ),
                row(
                    "feedback",
                    "Feedback",
                    "add",
                    Some("<text>"),
                    "Record feedback about this session"
                ),
                row(
                    "goal",
                    "Goal",
                    "add",
                    Some("[<objective>|clear|edit <objective>|pause|resume]"),
                    "Set or view the goal for a long-running task"
                ),
                row(
                    "permission",
                    "Permission",
                    "commands",
                    Some("<preset>"),
                    "Switch the permission preset (sandbox mode + approval policy)"
                ),
            ]
        );
    }
}
