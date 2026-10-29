//! The commands host: the registry, the built-in commands wired to the services they drive, and what the
//! routes read.
//!
//! Ported from `src/commands/service.ts`. Only the session service is required. The goal, context and model
//! services are optional, and a command that needs an absent one answers with a sentence naming it, so a
//! profile without one still lists every command rather than the whole layer failing to load. The sandbox
//! default — the mode a session that recorded none runs under — is the binary's to pass, as is the heddle home
//! the anonymous feedback id lives in.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use heddle_context::{ContextService, PrepareOptions};
use heddle_goal::{CreateGoal, EditGoal, GoalRef, GoalService, GoalView};
use heddle_llm::ModelService;
use heddle_sandbox::SandboxMode;
use heddle_session::{SessionHandle, SessionService, SessionStore};
use serde_json::Value;

use crate::builtins::{
    AnonymousUser, CompactionHost, CompactionOutcome, GoalHost, GoalLike, GoalRefLike,
    PermissionHost, compact_command, export_command, feedback_command, goal_command,
    permission_command,
};
use crate::registry::{CommandExecution, CommandLog, CommandRegistry};
use crate::text;

/// The sentence every `/goal` answers when the profile loads no goal service.
pub const NO_GOAL_SERVICE: &str = "the goal service is not loaded in this profile";

/// The sentence `/compact` answers when the profile loads no context service.
pub const NO_CONTEXT_SERVICE: &str =
    "Compaction is unavailable because the context service is not loaded.";

/// The sentence `/compact` answers when no endpoint could summarise.
pub const NO_SUMMARY_ENDPOINT: &str =
    "Compaction is unavailable because no model endpoint is configured to summarise with.";

/// The file under the heddle home that holds `/feedback`'s anonymous id.
pub const FEEDBACK_USER_FILE: &str = "feedback-user-id";

/// The log event a compaction's summary is recorded as.
const COMPACTION_SUMMARY_EVENT: &str = "compaction/summary";

/// What the built-in commands are wired to.
#[derive(Clone)]
pub struct CommandServices {
    /// The session service: the log every run writes to, and each session's meta and mode.
    pub sessions: Arc<SessionService>,
    /// The goal service `/goal` drives; `None` when the profile loads none.
    pub goals: Option<Arc<GoalService>>,
    /// The context service `/compact` reduces with; `None` when the profile loads none.
    pub context: Option<Arc<ContextService<SessionStore>>>,
    /// The model service whose default endpoint summarises when the session records none.
    pub models: Option<Arc<ModelService>>,
    /// The deployment's sandbox mode: what a session that recorded no mode runs under.
    pub sandbox_default: SandboxMode,
    /// The heddle home, where `/feedback`'s anonymous id is kept.
    pub heddle_home: PathBuf,
}

/// The commands host the routes read: the registry and the session service its runs write through.
pub struct Commands {
    registry: CommandRegistry,
    sessions: Arc<SessionService>,
}

impl std::fmt::Debug for Commands {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Commands")
            .field("registry", &self.registry)
            .finish_non_exhaustive()
    }
}

impl Commands {
    /// The registry with the five built-in commands wired to `services`.
    pub fn new(services: CommandServices) -> Self {
        let registry = CommandRegistry::new();
        let log: Arc<dyn CommandLog> = Arc::clone(services.sessions.store()) as Arc<dyn CommandLog>;
        let home = services.heddle_home.clone();
        let anonymous: AnonymousUser = Arc::new(move || anonymous_user(&home));
        let builtins = [
            goal_command(Arc::new(ServiceGoals {
                goals: services.goals.clone(),
            })),
            compact_command(Arc::new(ServiceCompaction {
                sessions: Arc::clone(&services.sessions),
                context: services.context.clone(),
                models: services.models.clone(),
            })),
            feedback_command(log, anonymous),
            permission_command(Arc::new(ServicePermission {
                sessions: Arc::clone(&services.sessions),
                fallback: services.sandbox_default,
            })),
            export_command(),
        ];
        for definition in builtins {
            // The built-ins' names are valid and distinct, so a refusal here is a bug in this file.
            registry
                .register(definition)
                .expect("a built-in command registers");
        }
        Self::with_registry(services.sessions, registry)
    }

    /// A host over a registry the caller filled.
    pub fn with_registry(sessions: Arc<SessionService>, registry: CommandRegistry) -> Self {
        Self { registry, sessions }
    }

    /// The registry.
    pub fn registry(&self) -> &CommandRegistry {
        &self.registry
    }

    /// The session `id` names, or `None`.
    pub fn open(&self, id: &str) -> Option<SessionHandle> {
        self.sessions.open(id)
    }

    /// Run a line in a session; `None` when it is not a registered command (and nothing was written).
    pub async fn execute(
        &self,
        session: &SessionHandle,
        line: &str,
    ) -> Result<Option<CommandExecution>, String> {
        self.registry
            .execute(self.sessions.store().as_ref(), session, line)
            .await
    }
}

impl From<&GoalView> for GoalLike {
    fn from(view: &GoalView) -> Self {
        GoalLike {
            id: view.goal.id.clone(),
            revision: view.goal.revision,
            objective: view.goal.objective.clone(),
            phase: view.goal.phase.as_str().to_owned(),
            max_goal_rounds: view.goal.max_goal_rounds,
            rounds_started: Some(view.rounds_started),
            activation: Some(view.activation.as_str().to_owned()),
        }
    }
}

fn goal_ref(goal: &GoalRefLike) -> GoalRef {
    GoalRef {
        id: goal.id.clone(),
        revision: goal.revision,
    }
}

/// The goal service is a goal host as it is: each call names the session by its id.
impl GoalHost for GoalService {
    fn get(&self, session: &SessionHandle) -> Result<Option<GoalLike>, String> {
        GoalService::get(self, &session.id)
            .map(|view| view.as_ref().map(GoalLike::from))
            .map_err(|error| error.to_string())
    }

    fn create(&self, session: &SessionHandle, objective: &str) -> Result<GoalLike, String> {
        GoalService::create(
            self,
            &session.id,
            CreateGoal {
                objective: objective.to_owned(),
                max_goal_rounds: None,
            },
        )
        .map(|view| GoalLike::from(&view))
        .map_err(|error| error.to_string())
    }

    fn edit(
        &self,
        session: &SessionHandle,
        goal: &GoalRefLike,
        objective: &str,
    ) -> Result<GoalLike, String> {
        GoalService::edit(
            self,
            &session.id,
            &goal_ref(goal),
            EditGoal {
                objective: Some(objective.to_owned()),
                max_goal_rounds: None,
            },
        )
        .map(|view| GoalLike::from(&view))
        .map_err(|error| error.to_string())
    }

    fn pause(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<GoalLike, String> {
        GoalService::pause(self, &session.id, &goal_ref(goal))
            .map(|view| GoalLike::from(&view))
            .map_err(|error| error.to_string())
    }

    fn resume(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<GoalLike, String> {
        GoalService::resume(self, &session.id, &goal_ref(goal))
            .map(|view| GoalLike::from(&view))
            .map_err(|error| error.to_string())
    }

    fn clear(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<(), String> {
        GoalService::clear(self, &session.id, &goal_ref(goal))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// The goal service when the profile loads one, or a host whose every call names its absence.
struct ServiceGoals {
    goals: Option<Arc<GoalService>>,
}

impl ServiceGoals {
    fn goals(&self) -> Result<&GoalService, String> {
        self.goals
            .as_deref()
            .ok_or_else(|| NO_GOAL_SERVICE.to_owned())
    }
}

impl GoalHost for ServiceGoals {
    fn get(&self, session: &SessionHandle) -> Result<Option<GoalLike>, String> {
        GoalHost::get(self.goals()?, session)
    }

    fn create(&self, session: &SessionHandle, objective: &str) -> Result<GoalLike, String> {
        GoalHost::create(self.goals()?, session, objective)
    }

    fn edit(
        &self,
        session: &SessionHandle,
        goal: &GoalRefLike,
        objective: &str,
    ) -> Result<GoalLike, String> {
        GoalHost::edit(self.goals()?, session, goal, objective)
    }

    fn pause(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<GoalLike, String> {
        GoalHost::pause(self.goals()?, session, goal)
    }

    fn resume(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<GoalLike, String> {
        GoalHost::resume(self.goals()?, session, goal)
    }

    fn clear(&self, session: &SessionHandle, goal: &GoalRefLike) -> Result<(), String> {
        GoalHost::clear(self.goals()?, session, goal)
    }
}

/// `/compact` over the context service: its forced reduction, priced before and after.
struct ServiceCompaction {
    sessions: Arc<SessionService>,
    context: Option<Arc<ContextService<SessionStore>>>,
    models: Option<Arc<ModelService>>,
}

impl CompactionHost for ServiceCompaction {
    /// Summarise the session's older history now.
    ///
    /// The endpoint that summarises is the one the session's turns use — its recorded endpoint, else the model
    /// service's default — so a manual compaction is written in the same voice as an automatic one.
    fn compact_now<'a>(
        &'a self,
        session: &'a SessionHandle,
    ) -> BoxFuture<'a, Result<CompactionOutcome, String>> {
        Box::pin(async move {
            let Some(context) = self.context.as_ref() else {
                return Err(NO_CONTEXT_SERVICE.to_owned());
            };
            let meta = self.sessions.meta(&session.id);
            let endpoint = meta
                .as_ref()
                .and_then(|meta| meta.endpoint().map(str::to_owned))
                .or_else(|| {
                    self.models
                        .as_ref()
                        .and_then(|models| models.default_endpoint(None))
                });
            let Some(endpoint) = endpoint else {
                return Err(NO_SUMMARY_ENDPOINT.to_owned());
            };
            let before = context
                .measure(session, &[])
                .map_err(|error| error.to_string())?;
            // `meta?.cwd ?? handle.dir`: a recorded folder, even an empty one, else the session's own folder.
            let cwd = meta
                .as_ref()
                .and_then(|meta| meta.as_map().get("cwd").and_then(Value::as_str))
                .map(str::to_owned)
                .unwrap_or_else(|| session.dir.clone());
            let model = meta
                .as_ref()
                .and_then(|meta| meta.model().map(str::to_owned));
            let report = context
                .prepare(
                    session,
                    &PrepareOptions {
                        cwd: Path::new(&cwd),
                        endpoint: &endpoint,
                        model: model.as_deref(),
                        tools: &[],
                        system: None,
                        summarizer: None,
                        force: true,
                    },
                )
                .await
                .map_err(|error| error.to_string())?;
            if !report.compacted {
                return Ok(CompactionOutcome::default());
            }
            let after = context
                .measure(session, &[])
                .map_err(|error| error.to_string())?;
            let events = self
                .sessions
                .events(session)
                .map_err(|error| error.to_string())?;
            let summary_seq = events
                .iter()
                .rev()
                .find(|event| event.kind == COMPACTION_SUMMARY_EVENT)
                .map(|event| event.seq);
            let replaced = (before.nodes.len() as i64 - after.nodes.len() as i64 + 1).max(1);
            Ok(CompactionOutcome {
                compacted: true,
                items: Some(replaced as u64),
                tokens: Some(before.total_tokens.saturating_sub(after.total_tokens)),
                summary_seq,
            })
        })
    }
}

/// `/permission` over the session's recorded mode, folded over the deployment's default.
struct ServicePermission {
    sessions: Arc<SessionService>,
    fallback: SandboxMode,
}

impl PermissionHost for ServicePermission {
    fn current(&self, session: &SessionHandle) -> Result<SandboxMode, String> {
        self.sessions
            .effective_mode(session, self.fallback)
            .map_err(|error| error.to_string())
    }

    fn set(&self, session: &SessionHandle, mode: SandboxMode) -> Result<bool, String> {
        self.sessions
            .set_mode(session, mode, self.fallback)
            .map(|change| change.changed)
            .map_err(|error| error.to_string())
    }
}

/// The anonymous id `/feedback` signs with: one random UUID per heddle home, created on first use.
///
/// DSH prints an anonymous user id with every recorded feedback so two notes from one person can be told apart
/// without knowing who they are; a file under the heddle home (`feedback-user-id`, mode 600) is the same
/// promise without an account. A stored value that is not UUID-shaped is replaced.
pub fn anonymous_user(home: &Path) -> Result<String, String> {
    let path = home.join(FEEDBACK_USER_FILE);
    if path.exists() {
        let stored = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let stored = text::trim(&stored);
        if text::is_uuid_shape(stored) {
            return Ok(stored.to_owned());
        }
    }
    let id = text::random_uuid();
    std::fs::create_dir_all(home).map_err(|error| format!("{}: {error}", home.display()))?;
    write_private(&path, &format!("{id}\n"))
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(id)
}

/// Write a file that only its owner may read when it is created (`writeFileSync(path, text, {mode: 0o600})`).
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{CommandResult, ParsedLine, parse_command_line};
    use crate::test_support::Fixture;
    use heddle_session::CreateOptions;

    fn services(fixture: &Fixture) -> CommandServices {
        CommandServices {
            sessions: Arc::new(SessionService::from_store(fixture.store.clone())),
            goals: None,
            context: None,
            models: None,
            sandbox_default: SandboxMode::WorkspaceWrite,
            heddle_home: fixture.root.join("home"),
        }
    }

    async fn run(commands: &Commands, session: &SessionHandle, line: &str) -> CommandResult {
        commands
            .execute(session, line)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("{line} is a command"))
            .result
    }

    #[test]
    fn the_host_lists_the_five_built_ins_and_opens_sessions() {
        let fixture = Fixture::new("host-list");
        let commands = Commands::new(services(&fixture));
        let names: Vec<String> = commands
            .registry()
            .list()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(
            names,
            ["compact", "export", "feedback", "goal", "permission"]
        );
        assert!(commands.open(&fixture.handle.id).is_some());
        assert!(
            commands
                .open("session-00000000-0000-4000-8000-000000000000")
                .is_none()
        );
        assert_eq!(
            parse_command_line("/goal x"),
            Some(ParsedLine {
                name: "goal".to_owned(),
                raw_input: " x".to_owned()
            })
        );
    }

    #[tokio::test]
    async fn an_absent_service_is_named_by_the_command_that_needs_it() {
        let fixture = Fixture::new("host-absent");
        let commands = Commands::new(services(&fixture));
        assert_eq!(
            run(&commands, &fixture.handle, "/goal").await,
            CommandResult::error(NO_GOAL_SERVICE)
        );
        assert_eq!(
            run(&commands, &fixture.handle, "/goal ship it").await,
            CommandResult::error(NO_GOAL_SERVICE)
        );
        assert_eq!(
            run(&commands, &fixture.handle, "/compact").await,
            CommandResult::error(NO_CONTEXT_SERVICE)
        );
    }

    fn context_service(fixture: &Fixture) -> Arc<ContextService<SessionStore>> {
        Arc::new(ContextService::new(
            fixture.store.clone(),
            heddle_context::ContextConfig::default(),
            heddle_context::ContextDependencies {
                model: None,
                heddle_home: fixture.root.join("home"),
            },
        ))
    }

    #[tokio::test]
    async fn compact_without_an_endpoint_says_so() {
        let fixture = Fixture::new("host-no-endpoint");
        let mut services = services(&fixture);
        services.context = Some(context_service(&fixture));
        let commands = Commands::new(services);
        assert_eq!(
            run(&commands, &fixture.handle, "/compact").await,
            CommandResult::error(NO_SUMMARY_ENDPOINT)
        );
    }

    #[tokio::test]
    async fn compact_over_the_real_context_service_has_nothing_to_compact_in_a_new_session() {
        let fixture = Fixture::new("host-compact");
        let handle = fixture
            .store
            .create(CreateOptions {
                cwd: Some(fixture.root.join("work").display().to_string()),
                endpoint: Some("scripted".to_owned()),
                ..CreateOptions::default()
            })
            .unwrap();
        let mut services = services(&fixture);
        services.context = Some(context_service(&fixture));
        let commands = Commands::new(services);
        assert_eq!(
            run(&commands, &handle, "/compact").await,
            CommandResult::success_text("No compactable history yet.")
        );
    }

    #[tokio::test]
    async fn goal_through_the_host_reaches_the_goal_service() {
        let fixture = Fixture::new("host-goal");
        let goals = Arc::new(GoalService::new(
            fixture.store.clone(),
            heddle_goal::GoalConfig::default(),
        ));
        let mut services = services(&fixture);
        services.goals = Some(Arc::clone(&goals));
        let commands = Commands::new(services);
        assert_eq!(
            run(&commands, &fixture.handle, "/goal ship the parity table").await,
            CommandResult::success_text("Goal set: ship the parity table")
        );
        assert_eq!(
            goals
                .get(&fixture.handle.id)
                .unwrap()
                .map(|view| view.goal.objective),
            Some("ship the parity table".to_owned())
        );
    }

    #[tokio::test]
    async fn permission_reads_and_writes_the_sessions_recorded_mode() {
        let fixture = Fixture::new("host-permission");
        let sessions = Arc::new(SessionService::from_store(fixture.store.clone()));
        let mut services = services(&fixture);
        services.sessions = Arc::clone(&sessions);
        services.sandbox_default = SandboxMode::ReadOnly;
        let commands = Commands::new(services);
        let available = "read-only, workspace-write, danger-full-access";
        assert_eq!(
            run(&commands, &fixture.handle, "/permission").await,
            CommandResult::success_text(format!(
                "current preset read-only (available: {available})"
            )),
            "the deployment's default when the session recorded none"
        );
        assert_eq!(
            run(&commands, &fixture.handle, "/permission workspace-write").await,
            CommandResult::success_text("preset workspace-write")
        );
        assert_eq!(
            sessions
                .effective_mode(&fixture.handle, SandboxMode::ReadOnly)
                .unwrap(),
            SandboxMode::WorkspaceWrite
        );
        let modes: Vec<Value> = fixture
            .events()
            .iter()
            .filter(|event| event.kind == heddle_session::MODE_EVENT)
            .filter_map(|event| event.get("mode").cloned())
            .collect();
        assert_eq!(modes, [Value::from("workspace-write")]);
        assert_eq!(
            run(&commands, &fixture.handle, "/permission danger-full-access").await,
            CommandResult::error(
                "widening to 'danger-full-access' needs the risk gate: choose it from the access control in the composer"
            )
        );
    }

    #[test]
    fn the_anonymous_id_is_made_once_per_home_kept_private_and_replaced_when_malformed() {
        let fixture = Fixture::new("host-anonymous");
        let home = fixture.root.join("home");
        let first = anonymous_user(&home).unwrap();
        assert!(text::is_uuid_shape(&first), "{first}");
        let path = home.join(FEEDBACK_USER_FILE);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{first}\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            anonymous_user(&home).unwrap(),
            first,
            "the same id next time"
        );
        std::fs::write(&path, "not an id\n").unwrap();
        let replaced = anonymous_user(&home).unwrap();
        assert!(text::is_uuid_shape(&replaced));
        assert_ne!(replaced, first);
    }

    #[tokio::test]
    async fn feedback_through_the_host_signs_with_the_homes_id() {
        let fixture = Fixture::new("host-feedback");
        let commands = Commands::new(services(&fixture));
        let result = run(&commands, &fixture.handle, "/feedback lovely").await;
        let id = anonymous_user(&fixture.root.join("home")).unwrap();
        assert_eq!(
            result,
            CommandResult::success_text(format!(
                "Feedback recorded for session {}\nAnonymous user: {id}.",
                fixture.handle.id
            ))
        );
    }
}
