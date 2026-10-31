//! The built-in host commands, with DSH's names, descriptions, argument forms and sentences.
//!
//! Ported from `src/commands/builtins.ts`. Each is a factory over the smallest host it needs, so a command is
//! judged against a double and wired to the real services in one place ([`crate::service`]). The words a
//! person reads are DSH's, re-read from its source on 2026-10-29; where heddle has no equivalent fact (a ZIP
//! archive, an approval preset) the sentence says what heddle does instead. `/goal` has its own module,
//! [`crate::goal`].

use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use heddle_sandbox::SandboxMode;
use heddle_session::{NewEvent, SessionHandle};

use crate::registry::{
    CommandAction, CommandDefinition, CommandInput, CommandLog, CommandResult, CommandSection,
};
use crate::text;

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

/// DSH's session-feedback categories, in the order its dialog offers them (`FEEDBACK_CATEGORIES`).
pub const FEEDBACK_CATEGORIES: [&str; 7] = [
    "task-result",
    "instruction-following",
    "product-interaction",
    "service-stability",
    "resource-cost",
    "security-privacy-permission",
    "other",
];

/// Append one session remark, as DSH's `recordFeedback` does: `feedback/record {text?, category?}`, blank text
/// recorded as absent (`recordFeedback`). `/feedback <text>` and the feedback dialog's route both write through here;
/// the category is the caller's to have checked against [`FEEDBACK_CATEGORIES`].
pub fn record_feedback(
    log: &dyn CommandLog,
    session: &SessionHandle,
    text: Option<&str>,
    category: Option<&str>,
) -> Result<(), String> {
    let mut event = NewEvent::new(FEEDBACK_EVENT);
    if let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) {
        event = event.field("text", text.to_owned());
    }
    if let Some(category) = category {
        event = event.field("category", category.to_owned());
    }
    log.append_event(session, event).map(|_| ())
}

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
            // The anonymous id is told to the person, not written into the remark (DSH's event is {text, category}).
            let user = anonymous_user()?;
            record_feedback(&*log, &context.session, Some(context.args.as_str()), None)?;
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
    use crate::goal::{GOAL_USAGE, GoalHost, goal_command};
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

    /// `/goal`'s card as DSH renders it, for a goal with no rounds under the default cap and no blocker.
    fn goal_card(
        title: &str,
        objective: &str,
        phase: &str,
        activation: &str,
        hint: &str,
    ) -> String {
        format!(
            "{title}\nStatus: {phase}\nObjective: {objective}\nRounds: 0/100\nActivation: {activation}\n\nCommands: {hint}"
        )
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
            .register(goal_command(goals.clone() as Arc<dyn GoalHost>, None))
            .unwrap();
        let session = fixture.handle.id.clone();
        let objective = || goals.get(&session).unwrap().map(|view| view.goal.objective);
        let phase = || {
            goals
                .get(&session)
                .unwrap()
                .map(|view| view.goal.phase.as_str())
        };
        let armed = "/goal edit <objective>, /goal pause, /goal clear";
        let stopped = "/goal edit <objective>, /goal resume, /goal clear";

        assert_eq!(
            run(&registry, &fixture, "/goal").await,
            success(&format!("No goal is currently set.\n{GOAL_USAGE}"))
        );
        assert_eq!(
            run(&registry, &fixture, "/goal ship the parity table").await,
            success(&goal_card(
                "Goal created",
                "ship the parity table",
                "active",
                "armed",
                armed
            ))
        );
        assert_eq!(objective().as_deref(), Some("ship the parity table"));
        assert_eq!(
            run(&registry, &fixture, "/goal something else").await,
            error(
                "A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it."
            )
        );
        assert_eq!(
            run(&registry, &fixture, "/goal").await,
            success(&goal_card(
                "Goal",
                "ship the parity table",
                "active",
                "armed",
                armed
            ))
        );
        assert_eq!(
            run(&registry, &fixture, "/goal edit").await,
            error(&format!(
                "Goal editing requires a replacement objective.\n{GOAL_USAGE}"
            ))
        );
        assert_eq!(
            run(&registry, &fixture, "/goal edit ship it twice").await,
            success(&goal_card(
                "Goal updated",
                "ship it twice",
                "active",
                "armed",
                armed
            ))
        );
        assert_eq!(
            run(&registry, &fixture, "/goal PAUSE").await,
            success(&goal_card(
                "Goal paused",
                "ship it twice",
                "paused",
                "disarmed",
                stopped
            )),
            "the words are case-insensitive"
        );
        assert_eq!(phase(), Some("paused"));
        assert_eq!(
            run(&registry, &fixture, "/goal resume").await,
            success(&goal_card(
                "Goal resumed",
                "ship it twice",
                "active",
                "armed",
                armed
            ))
        );
        assert_eq!(phase(), Some("active"));
        assert_eq!(
            run(&registry, &fixture, "/goal clear").await,
            success("Goal cleared.")
        );
        assert_eq!(objective(), None);
        assert_eq!(
            run(&registry, &fixture, "/goal pause").await,
            error(&format!(
                "No goal is currently set; /goal pause requires one. {GOAL_USAGE}"
            ))
        );
        assert_eq!(
            run(&registry, &fixture, "/goal edit x").await,
            error(&format!(
                "No goal is currently set; /goal edit requires one. {GOAL_USAGE}"
            ))
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
    async fn a_goal_service_refusal_is_dshs_one_sentence_recorded_as_the_runs_error() {
        let fixture = Fixture::new("goal-refusal");
        let goals = Arc::new(GoalService::new(
            fixture.store.clone(),
            GoalConfig::default(),
        ));
        let registry = CommandRegistry::new();
        registry.register(goal_command(goals, None)).unwrap();
        let long = "x".repeat(heddle_goal::MAX_OBJECTIVE_LENGTH + 1);
        assert_eq!(
            run(&registry, &fixture, &format!("/goal {long}")).await,
            error(
                "The goal command is not valid for the current state. Run /goal to view available commands."
            )
        );
        let done = fixture
            .events()
            .iter()
            .rfind(|event| event.kind == crate::registry::COMMAND_DONE_EVENT)
            .cloned()
            .expect("command/done");
        assert_eq!(done.get("kind"), Some(&json!("error")));
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
            None,
            "DSH's event is {{text, category}}: the anonymous id is told to the person, not written"
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
        registry.register(goal_command(goals, None)).unwrap();
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
