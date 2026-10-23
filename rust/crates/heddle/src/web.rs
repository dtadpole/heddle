//! `heddle web`: the server over the booted tree — `heddle-server`'s entry point, given the harness.
//!
//! The command boots the tree the command line names and refuses a tree with an entry still pending
//! (the TypeScript build's one check before serving), reports each row it could not start, then hands
//! `heddle_server::command::run` the [`Harness`] and serves until SIGINT or SIGTERM.
//!
//! The harness takes each service the boot provided — the session store through `heddle-server`'s own
//! adapter, the model and the sandbox through the small views below — and keeps the server's
//! *unavailable* stand-in for every service not composed yet, which answers an empty list or the
//! sentence naming the missing service, never an invented session or answer.

use std::path::PathBuf;
use std::sync::Arc;

use heddle_server::Harness;
use heddle_server::services::{
    ModelService as ServerModels, SandboxService as ServerSandbox, ServiceError, TurnOutcome,
    TurnRequest, TurnRunner,
};
use serde_json::Value;

use crate::boot::Boot;
use crate::cli::Args;
use crate::output::Output;
use crate::{Exit, Invocation};

/// The harness a booted tree gives the server.
pub fn harness(boot: &Boot, cwd: PathBuf) -> Harness {
    let mut harness = Harness::unavailable(cwd);
    if let Some(sessions) = boot
        .services
        .get::<Arc<heddle_session::SessionService>>("session")
    {
        harness.sessions = Arc::new(heddle_server::adapters::StoreSessions::new(
            heddle_session::SessionService::from_store(Arc::clone(sessions.store())),
        ));
    }
    if let (Some(runtime), Some(sessions)) = (
        boot.services
            .get::<Arc<heddle_agent::AgentRuntime>>("agent-runtime")
            .or_else(|| {
                crate::runtime::agent_runtime(&boot.services)
                    .ok()
                    .map(Arc::new)
            }),
        boot.services
            .get::<Arc<heddle_session::SessionService>>("session"),
    ) {
        harness.turns = Arc::new(Turns { runtime, sessions });
    }
    if let (Some(workspaces), Some(sessions)) = (
        boot.services
            .get::<Arc<heddle_workspace::WorkspaceService>>("workspace"),
        boot.services
            .get::<Arc<heddle_session::SessionService>>("session"),
    ) {
        harness.workspaces = Some(Arc::new(Roots {
            workspaces,
            sessions,
        }));
    }
    if let Some(service) = boot
        .services
        .get::<Arc<heddle_sandbox::ApprovalService>>("approvals")
    {
        harness.approvals = Some(Arc::new(Approvals { service }));
    }
    if let Some(service) = boot.services.get::<Arc<heddle_todo::TodoService>>("todo") {
        harness.todos = Some(Arc::new(Todos { service }));
    }
    if let Some(service) = boot.services.get::<Arc<heddle_team::TeamService>>("team") {
        harness.team = Some(Arc::new(Team { service }));
    }
    if let Some(service) = boot.services.get::<Arc<heddle_llm::ModelService>>("model") {
        harness.models = Arc::new(Models { service });
    }
    if let Some(service) = boot
        .services
        .get::<Arc<heddle_sandbox::SandboxService>>("sandbox")
    {
        harness.sandbox = Arc::new(Sandbox { service });
    }
    harness
}

/// Where the page's vendored assets are looked for: the base layer's directory and the working one.
pub fn asset_roots(anchor: &std::path::Path, cwd: &std::path::Path) -> Vec<PathBuf> {
    let mut roots = vec![anchor.to_path_buf()];
    if cwd != anchor {
        roots.push(cwd.to_path_buf());
    }
    roots
}

/// `heddle web`.
pub fn web(args: &Args, invocation: &Invocation, boot: Boot, out: &mut Output<'_>) -> Exit {
    let pending = crate::boot::settle(&boot);
    if !pending.is_empty() {
        boot.dispose();
        return out.fail(&format!(
            "{} entr(y/ies) are still pending: {}",
            pending.len(),
            pending.join(", ")
        ));
    }
    for (id, name) in crate::boot::failed_entries(&boot) {
        out.err(&format!("heddle web: row '{id}' ({name}) did not load\n"));
    }
    let harness = harness(&boot, invocation.cwd.clone());
    let shutdown = heddle_tools::CancellationToken::new();
    let context = heddle_server::command::Context {
        cwd: invocation.cwd.clone(),
        harness: &harness,
        // The hub the session store was given its listener over at boot.
        events: boot.services.get::<heddle_server::EventHub>("event-hub"),
        routers: page_routers(&boot, &invocation.env),
        views: page_views(&boot, &invocation.env),
        asset_roots: asset_roots(&boot.anchor, &invocation.cwd),
        secret_path: Some(heddle_config::heddle_home(&invocation.env).join("web-secret")),
        notes: start_notes(&boot),
        shutdown: shutdown.clone(),
    };
    let web_args = heddle_server::command::Args {
        host: args.host.clone(),
        port: args.port,
        endpoint: args.endpoint.clone(),
        max_rounds: args.max_rounds,
        dry_run: args.dry_run,
        json: args.json,
    };
    let runtime = crate::runtime::tokio();
    // The only honest lifetime for a server: until it is interrupted.
    runtime.spawn(async move {
        wait_for_stop().await;
        shutdown.cancel();
    });
    let (stdout, stderr) = out.writers();
    let code = runtime.block_on(heddle_server::command::run(
        heddle_server::command::Command::Web,
        &web_args,
        &context,
        stdout,
        stderr,
    ));
    boot.dispose();
    if code == 0 {
        Exit::Success
    } else {
        Exit::Failure
    }
}

/// The lines web reports once it is up and before the URL: the teams a previous process left mid-way,
/// settled and their queued mail delivered (`heddle_team::command::web_start_note`).
fn start_notes(boot: &Boot) -> Vec<String> {
    let mut notes = Vec::new();
    if let Some(team) = boot.services.get::<Arc<heddle_team::TeamService>>("team")
        && let Some(note) =
            crate::runtime::tokio().block_on(heddle_team::command::web_start_note(&team))
    {
        notes.push(note);
    }
    notes
}

/// Resolve on SIGINT or SIGTERM, whichever comes first.
async fn wait_for_stop() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut interrupt), Ok(mut terminate)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
}

/// A turn the page posts, on the run's shared agent runtime: the session's events reach the page through
/// the store's listener, and the request's token is the turn's, so `/stop` cancels exactly it.
struct Turns {
    runtime: Arc<heddle_agent::AgentRuntime>,
    sessions: Arc<heddle_session::SessionService>,
}

impl TurnRunner for Turns {
    fn run_turn(
        &self,
        request: TurnRequest,
    ) -> futures::future::BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
        let runtime = Arc::clone(&self.runtime);
        let sessions = Arc::clone(&self.sessions);
        Box::pin(async move {
            let handle = sessions
                .open(&request.session)
                .ok_or_else(|| ServiceError::new(format!("no session '{}'", request.session)))?;
            let mut options =
                heddle_agent::RunTurnOptions::new(handle, request.endpoint, request.prompt);
            options.attachments = request
                .attachments
                .into_iter()
                .filter_map(|part| serde_json::from_value(part).ok())
                .collect();
            options.model = request.model;
            options.reasoning_effort = request.reasoning_effort;
            // The page's rule is DSH's: no round cap unless the server was started with one.
            options.max_rounds = match request.max_rounds {
                Some(rounds) => heddle_agent::RoundLimit::Rounds(rounds),
                None => heddle_agent::RoundLimit::Unbounded,
            };
            options.cancel = Some(request.cancel);
            let result = heddle_agent::run_turn(&runtime, options)
                .await
                .map_err(|error| ServiceError::new(error.to_string()))?;
            Ok(TurnOutcome {
                text: result.text,
                finish_reason: result.finish_reason,
                rounds: u64::from(result.rounds),
                denials: result
                    .denials
                    .iter()
                    .filter_map(|denial| serde_json::to_value(denial).ok())
                    .collect(),
                ended: Some(result.ended),
                usage: serde_json::to_value(result.usage).ok(),
            })
        })
    }
}

/// The registered roots and the tree, as the page's routes use them, over `heddle-workspace`'s service.
/// The tree is drawn from the crate's own session metadata, which carries the folder binding and the
/// archive flag the routes' summary does not.
struct Roots {
    workspaces: Arc<heddle_workspace::WorkspaceService>,
    sessions: Arc<heddle_session::SessionService>,
}

fn service_error(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::new(error.to_string())
}

impl heddle_server::services::WorkspaceService for Roots {
    fn owns(&self, path: &std::path::Path) -> bool {
        self.workspaces.owner(&path.to_string_lossy()).is_some()
    }

    fn tree(
        &self,
        path: Option<&std::path::Path>,
        archived: heddle_server::services::ArchivedFilter,
        _sessions: &[heddle_server::services::SessionMeta],
    ) -> Result<Value, ServiceError> {
        use heddle_server::services::ArchivedFilter as Wanted;
        let input = heddle_workspace::TreeInput {
            roots: self
                .workspaces
                .list()
                .iter()
                .map(heddle_workspace::TreeRoot::from)
                .collect(),
            sessions: self.sessions.list(),
            generated: self.workspaces.generated().to_vec(),
            archived: match archived {
                Wanted::Hide => heddle_workspace::ArchivedFilter::Hide,
                Wanted::Show => heddle_workspace::ArchivedFilter::Show,
                Wanted::Only => heddle_workspace::ArchivedFilter::Only,
            },
        };
        let path = path.map(|path| path.to_string_lossy().into_owned());
        serde_json::to_value(heddle_workspace::tree(path.as_deref(), &input)).map_err(service_error)
    }

    fn add(
        &self,
        path: &std::path::Path,
        name: Option<&str>,
    ) -> Result<(Value, bool), ServiceError> {
        let added = self
            .workspaces
            .add(&path.to_string_lossy(), name)
            .map_err(service_error)?;
        Ok((
            serde_json::to_value(&added.record).map_err(service_error)?,
            added.created,
        ))
    }

    fn find(&self, id: &str) -> bool {
        self.workspaces.list().iter().any(|record| record.id == id)
    }

    fn remove(
        &self,
        id: &str,
        _sessions: &[heddle_server::services::SessionMeta],
    ) -> Result<Value, ServiceError> {
        let removal = self
            .workspaces
            .remove(id, &self.sessions.list(), false)
            .map_err(service_error)?;
        serde_json::to_value(removal).map_err(service_error)
    }

    fn rename(&self, id: &str, title: &str) -> Result<Option<Value>, ServiceError> {
        let renamed = self.workspaces.rename(id, title).map_err(service_error)?;
        renamed
            .map(|record| serde_json::to_value(record).map_err(service_error))
            .transpose()
    }

    fn ensure_owner(&self, folder: &std::path::Path) {
        let _ = self.workspaces.ensure_owner(&folder.to_string_lossy());
    }
}

/// The approval service as the page answers it: while the server runs it is the answerer, so an `ask`
/// becomes a card; the page lists what waits, answers one by id, and is told of each new request.
struct Approvals {
    service: Arc<heddle_sandbox::ApprovalService>,
}

impl heddle_server::services::ApprovalService for Approvals {
    fn attach_answerer(&self) -> Box<dyn FnOnce() + Send> {
        let guard = self.service.attach_answerer();
        Box::new(move || drop(guard))
    }

    fn pending_requests(&self) -> Vec<Value> {
        self.service
            .pending_requests()
            .iter()
            .filter_map(|request| serde_json::to_value(request).ok())
            .collect()
    }

    fn answer(&self, id: &str, outcome: heddle_server::services::ApprovalOutcome) -> bool {
        use heddle_server::services::ApprovalOutcome;
        let answer = match outcome {
            ApprovalOutcome::AllowedOnce => heddle_sandbox::Answer::AllowedOnce,
            ApprovalOutcome::Rejected => heddle_sandbox::Answer::Rejected,
            ApprovalOutcome::Cancelled => heddle_sandbox::Answer::Cancelled,
        };
        self.service.answer(id, answer)
    }

    fn subscribe(&self) -> Option<futures::stream::BoxStream<'static, Value>> {
        use futures::StreamExt;
        let receiver = self.service.subscribe();
        // Each new request as the card's JSON; a slow reader skips what it missed rather than ending.
        let stream = futures::stream::unfold(receiver, |mut receiver| async move {
            loop {
                match receiver.recv().await {
                    Ok(request) => {
                        if let Ok(value) = serde_json::to_value(&request) {
                            return Some((value, receiver));
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                }
            }
        });
        Some(stream.boxed())
    }
}

/// A session's todo list as the page's panel reads it: the fold of its `todo/write` events.
struct Todos {
    service: Arc<heddle_todo::TodoService>,
}

impl heddle_server::services::TodoService for Todos {
    fn get(&self, session: &str) -> Option<Value> {
        let view = self.service.get(session).ok()??;
        serde_json::to_value(view).ok()
    }
}

/// A Lead session's team as the page's panel reads it: `heddle-team`'s own API view.
struct Team {
    service: Arc<heddle_team::TeamService>,
}

impl heddle_server::services::TeamService for Team {
    fn view(&self, session: &str) -> Result<heddle_server::services::TeamView, ServiceError> {
        let view = heddle_team::api::team_view(&self.service, session).map_err(service_error)?;
        let value = serde_json::to_value(view).map_err(service_error)?;
        let field = |key: &str| value.get(key).cloned().unwrap_or(Value::Null);
        Ok(heddle_server::services::TeamView {
            lead: field("lead"),
            members: field("members"),
            tasks: field("tasks"),
            messages: field("messages"),
            delivered: field("delivered"),
        })
    }
}

/// What the page's feature routers read: the booted session store, the workspace roots and the tools.
struct PageHost {
    sessions: Arc<heddle_session::SessionService>,
    workspaces: Option<Arc<heddle_workspace::WorkspaceService>>,
    tools: Option<Arc<heddle_tools::ToolRegistry>>,
    home: PathBuf,
}

fn page_host(boot: &Boot, env: &heddle_config::Env) -> Option<Arc<PageHost>> {
    Some(Arc::new(PageHost {
        sessions: boot
            .services
            .get::<Arc<heddle_session::SessionService>>("session")?,
        workspaces: boot
            .services
            .get::<Arc<heddle_workspace::WorkspaceService>>("workspace"),
        tools: boot
            .services
            .get::<Arc<heddle_tools::ToolRegistry>>("tools"),
        home: heddle_config::heddle_home(env),
    }))
}

/// The feature routers mounted behind the door: the files panel and the trajectory's log and stats.
fn page_routers(boot: &Boot, env: &heddle_config::Env) -> Vec<axum::Router> {
    let Some(host) = page_host(boot, env) else {
        return Vec::new();
    };
    vec![
        heddle_web_files::routes::mount(axum::Router::new(), host.clone()),
        heddle_web_trajectory::routes::router(host),
    ]
}

/// The `?view=` projections of a session: the trajectory's ledger.
fn page_views(
    boot: &Boot,
    env: &heddle_config::Env,
) -> Vec<(String, Arc<dyn heddle_server::server::SessionView>)> {
    match page_host(boot, env) {
        Some(host) => vec![("ledger".to_owned(), Arc::new(Ledger { host }) as _)],
        None => Vec::new(),
    }
}

impl heddle_web_files::host::FilesHost for PageHost {
    fn heddle_home(&self) -> PathBuf {
        self.home.clone()
    }

    fn workspace_owner(&self, path: &std::path::Path) -> heddle_web_files::host::WorkspaceAnswer {
        use heddle_web_files::host::WorkspaceAnswer;
        match &self.workspaces {
            None => WorkspaceAnswer::NotLoaded,
            Some(workspaces) => match workspaces.owner(&path.to_string_lossy()) {
                Some(_) => WorkspaceAnswer::Owned,
                None => WorkspaceAnswer::Outside,
            },
        }
    }

    fn read_file_text(
        &self,
        path: &std::path::Path,
    ) -> Result<heddle_web_files::host::FileReading, heddle_web_files::host::FileReadError> {
        use heddle_web_files::host::FileReadError;
        match heddle_workspace::read_file_text(&path.to_string_lossy(), None) {
            Ok(reading) => serde_json::to_value(reading)
                .and_then(serde_json::from_value)
                .map_err(|error| FileReadError::NotText(error.to_string())),
            Err(error @ heddle_workspace::FileReadError::NotAFile(_)) => {
                Err(FileReadError::NotAFile(error.to_string()))
            }
            Err(error) => Err(FileReadError::NotText(error.to_string())),
        }
    }
}

impl heddle_web_composer::SessionLookup for PageHost {
    fn session_events(&self, id: &str) -> Option<Vec<Value>> {
        let handle = self.sessions.open(id)?;
        let events = self.sessions.events(&handle).ok()?;
        Some(events.iter().map(|event| event.to_value()).collect())
    }
}

impl heddle_web_trajectory::JsonHighlighter for PageHost {
    fn render_json(&self, source: &str) -> String {
        heddle_web_files::highlight::highlight_code(source, Some("json"))
    }
}

impl heddle_web_trajectory::routes::TrajectoryHost for PageHost {
    fn session_title(&self, id: &str) -> Option<String> {
        self.sessions
            .meta(id)
            .and_then(|meta| meta.title().map(str::to_owned))
    }

    fn tool_specs(&self) -> Vec<heddle_web_composer::ToolSpec> {
        self.tools
            .as_ref()
            .map(|registry| {
                registry
                    .describe()
                    .iter()
                    .filter_map(|spec| {
                        serde_json::to_value(spec)
                            .and_then(serde_json::from_value)
                            .ok()
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// `GET /api/sessions/{id}?view=ledger`: the trajectory's projection of the session.
struct Ledger {
    host: Arc<PageHost>,
}

impl heddle_server::server::SessionView for Ledger {
    fn respond(
        &self,
        _state: &heddle_server::server::AppState,
        session: &heddle_server::respond::SessionId,
        _events: &[Value],
    ) -> axum::response::Response {
        heddle_web_trajectory::routes::ledger_response(&*self.host, session.as_str())
    }
}

/// The server's view of `heddle-llm`'s service.
struct Models {
    service: Arc<heddle_llm::ModelService>,
}

impl ServerModels for Models {
    fn names(&self) -> Vec<String> {
        self.service.names()
    }

    fn default_endpoint(&self) -> Option<String> {
        self.service.nominated()
    }

    fn declares_level(&self, endpoint: &str, model: Option<&str>, effort: &str) -> bool {
        self.service
            .endpoint(endpoint)
            .and_then(|config| config.reasoning_level_for(model, effort))
            .is_some()
    }
}

/// The server's view of `heddle-sandbox`'s service.
struct Sandbox {
    service: Arc<heddle_sandbox::SandboxService>,
}

impl ServerSandbox for Sandbox {
    fn default_mode(&self) -> String {
        self.service.mode().to_string()
    }

    fn workspace_root(&self) -> String {
        self.service.workspace_root().display().to_string()
    }

    fn transition(
        &self,
        current: &str,
        requested: Option<&Value>,
        confirm: Option<&Value>,
    ) -> Result<String, String> {
        let current = heddle_sandbox::SandboxMode::parse(current).unwrap_or(self.service.mode());
        heddle_sandbox::permission_transition(current, requested, confirm)
            .map(|change| change.mode.to_string())
            .map_err(|refusal| refusal.reason().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::Services;
    use serde_json::json;

    fn empty_boot() -> Boot {
        Boot {
            rows: Vec::new(),
            entries: Vec::new(),
            services: Services::new(),
            anchor: PathBuf::from("/repo"),
        }
    }

    #[test]
    fn the_asset_roots_are_the_checkout_then_the_working_directory() {
        assert_eq!(
            asset_roots(std::path::Path::new("/repo"), std::path::Path::new("/work")),
            vec![PathBuf::from("/repo"), PathBuf::from("/work")]
        );
        assert_eq!(
            asset_roots(std::path::Path::new("/repo"), std::path::Path::new("/repo")),
            vec![PathBuf::from("/repo")]
        );
    }

    #[test]
    fn a_tree_with_a_pending_entry_is_refused_before_serving() {
        let mut boot = empty_boot();
        boot.entries.push(crate::boot::Entry {
            id: "announce".to_owned(),
            name: "./src/plugins/announce.ts".to_owned(),
            component: crate::builtins::ComponentRef::Unresolved("announce".to_owned()),
            requires: vec!["greeting".to_owned()],
            state: crate::boot::FiberState::Pending,
            error: None,
        });
        let mut captured = crate::output::Captured::default();
        let invocation = Invocation {
            argv: Vec::new(),
            env: heddle_config::Env::default(),
            cwd: PathBuf::from("/repo"),
        };
        let argv: Vec<String> = ["web", "--dry-run"]
            .iter()
            .map(|w| (*w).to_owned())
            .collect();
        let args = crate::cli::parse_args(&argv).expect("parses");
        let exit = {
            let mut out = captured.output();
            web(&args, &invocation, boot, &mut out)
        };
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            captured.stderr_text(),
            "heddle: 1 entr(y/ies) are still pending: announce\n"
        );
    }

    #[test]
    fn the_harness_takes_the_model_and_sandbox_the_boot_provided() {
        let mut services = Services::new();
        let models = heddle_llm::ModelService::from_configuration(
            heddle_config::default_endpoints(),
            Some("scripted"),
        )
        .expect("the offline default composes");
        services.provide("model", Arc::new(models));
        let host = heddle_sandbox::SandboxHost {
            cwd: PathBuf::from("/work"),
            harness_home: PathBuf::from("/home/.heddle"),
            platform: heddle_sandbox::Platform::current(),
        };
        let config = heddle_sandbox::SandboxConfig {
            mode: heddle_sandbox::SandboxMode::ReadOnly,
            ..heddle_sandbox::SandboxConfig::default()
        };
        services.provide(
            "sandbox",
            Arc::new(heddle_sandbox::SandboxService::new(&config, &host)),
        );
        let mut boot = empty_boot();
        boot.services = services;
        let harness = harness(&boot, PathBuf::from("/work"));
        assert_eq!(harness.models.names(), vec!["scripted".to_owned()]);
        assert_eq!(harness.sandbox.default_mode(), "read-only");
        assert_eq!(
            harness
                .sandbox
                .transition("read-only", Some(&json!("workspace-write")), None),
            Ok("workspace-write".to_owned())
        );
        assert!(
            harness
                .sandbox
                .transition("read-only", Some(&json!("danger-full-access")), None)
                .is_err(),
            "full access needs the confirmation"
        );
    }
}
