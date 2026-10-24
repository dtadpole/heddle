//! The `team` row composed over the crates that own each capability: what the binary calls, with one line, when
//! a profile loads the row (feature `compose`).
//!
//! The rest of this crate depends on no other heddle crate; this module is where the seams in
//! [`crate::ports`] meet their owners, so the binary's composition root does not have to hand-write them
//! (D-043; the coordinator's ruling of 2026-10-22 that the team row is drafted in this crate):
//!
//! | Seam | Over |
//! |---|---|
//! | [`TeamStore`] | [`SessionTeamStore`], over `heddle-session`'s `SessionStore` |
//! | [`TeamAgent`] | `heddle-agent`'s [`begin_turn`](heddle_agent::begin_turn) on the turn's own `AgentRuntime`, so the prompt is in the member's log and the turn is live before `begin` returns |
//! | [`TeamLive`] | `heddle-agent`'s `TurnRegistry`, when the profile loads `turns` |
//! | the nine tools | `heddle-tools`' registry, each an async `tool_fn` (`send_message` awaits delivery, `wait_agent` up to 120 s) |
//! | `GET /api/team` | [`ServerTeam`], `heddle-server`'s `TeamService` port over [`crate::api::team_view`] |
//!
//! The binary's side, in the row's `start` and in `web`:
//!
//! ```text
//! let plugin = heddle_team::compose::start_row(heddle_team::compose::TeamRow {
//!     config, sessions, models, runtime: crate::runtime::shared_runtime(services)?, emit_changed: None, warn,
//! })?;
//! services.provide("team", Arc::clone(&plugin.service));
//! // web: harness.team = Some(Arc::new(ServerTeam(service))); and before it starts,
//! //      if let Some(note) = heddle_team::command::web_start_note(&service).await { notes.push(note) }
//! ```

use std::sync::{Arc, Weak};

use heddle_agent::{AgentRuntime, RunTurnOptions, TurnRegistry};
use heddle_llm::ModelService;
use heddle_session::{
    AppendOptions, ContentPart, CreateOptions, ForkAttribution, Message, NewEvent, Role,
    SessionHandle, SessionOrigin, SessionService, SessionStore,
};
use heddle_tools::{ToolError, ToolRegistry, ToolResult};
use serde_json::Value;

use crate::api::team_view;
use crate::plugin::{TeamAgent, TeamConfig, TeamPlugin, TeamPluginDeps, TeamTurnRequest};
use crate::ports::{ChildSession, PortError, SessionMetaView, TeamLive, TeamStore, TurnFuture};
use crate::service::{TeamNotify, TeamService, TeamWarn};
use crate::state::SessionId;
use crate::tool::{TeamTools, ToolOutcome, team_tool_specs};

/// What the `team` row is started from: its configuration and the services it injects.
pub struct TeamRow<'a> {
    /// The row's `config`; `{}` takes the TypeScript defaults.
    pub config: &'a Value,
    /// The `session` service; the team journals into its store.
    pub sessions: Arc<SessionService>,
    /// The `model` service, for the default endpoint of a member whose session names none.
    pub models: Arc<ModelService>,
    /// The runtime a turn runs on — the same one the Lead's turn uses, so a teammate's turn has the same tools
    /// (the nine team tools among them, once registered here) and the same live-turn registry. The team keeps only
    /// a weak reference: the runtime's registry holds the team's tools, which hold the service, so a strong one
    /// would be a cycle that never drops. Whoever owns the run keeps the `Arc`.
    pub runtime: Arc<AgentRuntime>,
    /// Announces `team/changed` on the event bus, when the binary mounts one.
    pub emit_changed: Option<TeamNotify>,
    /// Where a recovery failure is reported (the TypeScript build logs `team: <message>` at warn).
    pub warn: Option<TeamWarn>,
}

/// Start the `team` row: read its config, build the service over the session store, the agent and the
/// live-turn registry, and register the nine tools with the runtime's registry. `Err` is the sentence the boot
/// reports for a failed row.
pub fn start_row(row: TeamRow<'_>) -> Result<TeamPlugin, String> {
    let config: TeamConfig =
        serde_json::from_value(row.config.clone()).map_err(|error| format!("team: {error}"))?;
    let store = Arc::clone(row.sessions.store());
    let live: Option<Arc<dyn TeamLive>> = row
        .runtime
        .turns
        .clone()
        .map(|turns| Arc::new(LiveTurns(turns)) as Arc<dyn TeamLive>);
    let registry = Arc::clone(&row.runtime.tools);
    let plugin = TeamPlugin::install(TeamPluginDeps {
        store: Arc::new(SessionTeamStore::new(Arc::clone(&store))),
        agent: Arc::new(RuntimeAgent {
            runtime: Arc::downgrade(&row.runtime),
            store,
            models: row.models,
        }),
        live,
        config,
        emit_changed: row.emit_changed,
        warn: row.warn,
    });
    register_tools(&registry, &plugin.tools)?;
    Ok(plugin)
}

/// Register the nine tools with a registry, each running [`TeamTools::call`] for the calling session.
///
/// The run is async on purpose: `send_message` awaits target-confirmed delivery and `wait_agent` waits up to
/// 120 seconds, which a synchronous closure could only do by blocking a runtime worker.
pub fn register_tools(registry: &ToolRegistry, tools: &TeamTools) -> Result<(), String> {
    for spec in team_tool_specs() {
        let name = spec.name;
        let spec = serde_json::to_value(&spec)
            .and_then(serde_json::from_value)
            .map_err(|error| format!("team: the {name} spec: {error}"))?;
        let tools = tools.clone();
        let tool = heddle_tools::tool_fn(spec, move |args, context| {
            let tools = tools.clone();
            let caller = context
                .context()
                .session
                .as_ref()
                .map(|handle| handle.id.clone());
            Box::pin(async move {
                let outcome = tools
                    .call(name, &Value::Object(args), caller.as_deref())
                    .await;
                Ok(tool_result(outcome))
            })
        });
        registry
            .register(tool)
            .map_err(|error| format!("team: {name}: {error}"))?;
    }
    Ok(())
}

/// A team tool's outcome as the registry's result; the two shapes are the same TypeScript `ToolResult`.
fn tool_result(outcome: ToolOutcome) -> ToolResult {
    ToolResult {
        output: outcome.output,
        error: outcome.error.map(|failure| ToolError {
            code: failure.code,
            message: failure.message,
        }),
        data: outcome.data,
    }
}

fn port(error: impl std::fmt::Display) -> PortError {
    PortError(error.to_string())
}

/// [`TeamStore`] over the session store.
pub struct SessionTeamStore {
    store: Arc<SessionStore>,
}

impl SessionTeamStore {
    pub fn new(store: Arc<SessionStore>) -> Self {
        Self { store }
    }

    fn handle(&self, session: &str) -> Result<SessionHandle, PortError> {
        self.store
            .open(session)
            .ok_or_else(|| PortError(format!("no session {session}")))
    }
}

impl TeamStore for SessionTeamStore {
    fn exists(&self, session: &str) -> bool {
        self.store.open(session).is_some()
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, PortError> {
        let handle = self.handle(session)?;
        let events = self.store.read(&handle).map_err(port)?;
        Ok(events.iter().map(|event| event.to_value()).collect())
    }

    fn meta(&self, session: &str) -> Option<SessionMetaView> {
        self.store.meta(session).map(|meta| SessionMetaView {
            id: meta.id().to_owned(),
            cwd: Some(meta.cwd().to_owned()),
            endpoint: meta.endpoint().map(str::to_owned),
            model: meta.model().map(str::to_owned),
            team_id: meta.team_id().map(str::to_owned),
        })
    }

    fn list(&self) -> Vec<SessionId> {
        self.store
            .list()
            .iter()
            .map(|meta| meta.id().to_owned())
            .collect()
    }

    fn create(&self, child: &ChildSession) -> Result<(), PortError> {
        self.store
            .create(CreateOptions {
                id: Some(child.id.clone()),
                cwd: child.cwd.clone(),
                endpoint: child.endpoint.clone(),
                model: child.model.clone(),
                title: Some(child.title.clone()),
                parent_session: Some(child.parent_session.clone()),
                origin: Some(SessionOrigin::Subagent),
                delegation_depth: Some(u64::from(child.delegation_depth)),
                team_id: Some(child.team_id.clone()),
                ..CreateOptions::default()
            })
            .map(|_| ())
            .map_err(port)
    }

    fn fork(&self, source: &str, child: &ChildSession) -> Result<bool, PortError> {
        self.store
            .fork(
                source,
                ForkAttribution {
                    parent_session: Some(child.parent_session.clone()),
                    origin: Some(SessionOrigin::Subagent),
                    delegation_depth: Some(u64::from(child.delegation_depth)),
                    team_id: Some(child.team_id.clone()),
                    title: Some(child.title.clone()),
                    id: Some(child.id.clone()),
                },
            )
            .map(|forked| forked.is_some())
            .map_err(port)
    }

    fn append(&self, session: &str, event: Value) -> Result<(), PortError> {
        let handle = self.handle(session)?;
        let event = NewEvent::try_from(event).map_err(port)?;
        self.store
            .append(&handle, event, AppendOptions::default())
            .map(|_| ())
            .map_err(port)
    }

    fn user_message(
        &self,
        session: &str,
        content: Vec<Value>,
        source: Value,
    ) -> Result<(), PortError> {
        let handle = self.handle(session)?;
        let content: Vec<ContentPart> =
            serde_json::from_value(Value::Array(content)).map_err(port)?;
        self.store
            .message(
                &handle,
                Message {
                    role: Role::User,
                    tool_call_id: None,
                    content,
                    source: Some(source),
                },
            )
            .map(|_| ())
            .map_err(port)
    }

    fn inherit_recorded_mode(&self, parent: &str, child: &str) -> Result<(), PortError> {
        let parent = self.handle(parent)?;
        let child = self.handle(child)?;
        heddle_session::inherit_recorded_mode::<Value>(&self.store, &parent, &child)
            .map(|_| ())
            .map_err(port)
    }
}

/// [`TeamAgent`] over `heddle-agent`: a member's turn begins on the shared runtime with purpose `team`.
struct RuntimeAgent {
    runtime: Weak<AgentRuntime>,
    store: Arc<SessionStore>,
    models: Arc<ModelService>,
}

impl TeamAgent for RuntimeAgent {
    fn begin_turn(&self, request: TeamTurnRequest) -> Result<TurnFuture, String> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or("the run that owned this team has ended")?;
        let handle = self
            .store
            .open(&request.session)
            .ok_or_else(|| format!("no session {}", request.session))?;
        let mut options = RunTurnOptions::new(handle, request.endpoint, request.prompt);
        options.source = Some(request.source);
        options.model = request.model;
        options.purpose = Some(request.purpose.to_owned());
        // begin_turn writes the prompt and registers the turn live before it returns: the ordering the team's
        // delivery proof and its boot recovery read the member's log for.
        let begun =
            heddle_agent::begin_turn(&runtime, options).map_err(|error| error.to_string())?;
        Ok(Box::pin(async move {
            begun
                .run()
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        }))
    }

    fn default_endpoint(&self) -> Option<String> {
        self.models.default_endpoint(None)
    }
}

/// [`TeamLive`] over the live-turn registry.
struct LiveTurns(TurnRegistry);

impl TeamLive for LiveTurns {
    fn is_running(&self, session: &str) -> bool {
        self.0.is_running(session)
    }

    fn abort(&self, session: &str) -> bool {
        self.0.abort(session, None)
    }
}

/// `heddle-server`'s `TeamService` port over this crate's service: `GET /api/team`'s 200 body from one fold, and
/// a refused fold as the server's 500.
pub struct ServerTeam(pub Arc<TeamService>);

impl heddle_server::services::TeamService for ServerTeam {
    fn view(
        &self,
        session: &str,
    ) -> Result<heddle_server::services::TeamView, heddle_server::services::ServiceError> {
        let view = team_view(&self.0, session).map_err(|error| {
            heddle_server::services::ServiceError::with_code(error.message, error.code.as_str())
        })?;
        let json = |value: Result<Value, serde_json::Error>| value.unwrap_or(Value::Null);
        Ok(heddle_server::services::TeamView {
            lead: Value::from(view.lead),
            members: json(serde_json::to_value(view.members)),
            tasks: json(serde_json::to_value(view.tasks)),
            messages: json(serde_json::to_value(view.messages)),
            delivered: json(serde_json::to_value(view.delivered)),
        })
    }
}
