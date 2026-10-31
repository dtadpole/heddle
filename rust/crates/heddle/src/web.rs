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
    ApprovalOutcome, ApprovalService as ServerApprovals, ModelService as ServerModels,
    SandboxService as ServerSandbox, ServiceError, TurnOutcome, TurnRequest, TurnRunner,
};
use serde_json::Value;

use crate::boot::{Boot, FiberState};
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
    if let Some(service) = boot.services.get::<Arc<heddle_llm::ModelService>>("model") {
        harness.models = Arc::new(Models { service });
    }
    // The agent presets (inventory A96): `GET /api/presets`, and the preset a session the page creates runs under.
    harness.presets = boot
        .services
        .get::<Arc<heddle_config::PresetRoster>>("presets");
    if let Some(service) = boot
        .services
        .get::<Arc<heddle_sandbox::SandboxService>>("sandbox")
    {
        harness.sandbox = Arc::new(Sandbox { service });
    }
    // The workspace row: the tree, the roots, and the folder a new chat starts in. Without it
    // `/api/tree` and a turn started in a folder answer 503, which is a page with nothing to click.
    if let (Some(service), Some(sessions)) = (
        boot.services
            .get::<Arc<heddle_workspace::WorkspaceService>>("workspace"),
        boot.services
            .get::<Arc<heddle_session::SessionService>>("session"),
    ) {
        harness.workspaces = Some(Arc::new(Workspaces { service, sessions }));
    }
    // The renderer a settled answer is drawn with (web.ts: `html: renderMarkdown(turn.text)`). The page
    // draws a history row's document, its edited-files card and its stop notice only from that `html`.
    harness.markdown = Some(heddle_server::services::markdown_renderer(|text: &str| {
        heddle_web_files::markdown::render_markdown(
            text,
            heddle_web_files::markdown::MarkdownOptions::default(),
        )
    }));
    // The composer's figures (tokens, context, cost) projected from the session's events, as the
    // trajectory crate draws them for the dock.
    // When no model request recorded a breakdown yet, the dock's context figure is measured now from
    // the session's surface, the tools and the baseline, as the trajectory crate asks.
    let measuring = (
        boot.services
            .get::<Arc<heddle_context::ContextService<heddle_session::SessionStore>>>("context"),
        boot.services
            .get::<Arc<heddle_session::SessionService>>("session"),
        boot.services
            .get::<Arc<heddle_tools::ToolRegistry>>("tools"),
    );
    harness.stats = Some(heddle_server::services::stats_projector(
        move |session: &str, events: &[Value]| {
            let measure = || {
                let (Some(context), Some(sessions)) = (measuring.0.as_ref(), measuring.1.as_ref())
                else {
                    return None;
                };
                let tools = measuring
                    .2
                    .as_ref()
                    .map(|tools| tools.describe())
                    .unwrap_or_default();
                let handle = sessions.open(session)?;
                let measured = context.measure(&handle, &tools).ok()?;
                Some(heddle_web_trajectory::stats::MeasuredSurface {
                    system_tokens: measured.system_tokens,
                    tools_tokens: measured.tools_tokens,
                    message_tokens: measured.message_tokens,
                })
            };
            to_json(heddle_web_trajectory::stats::session_stats_view(
                events, measure,
            ))
        },
    ));
    // The goal, todo and team rows: the page's goal, todo and team panels read them.
    if let Some(service) = boot.services.get::<Arc<heddle_goal::GoalService>>("goal") {
        harness.goals = Some(Arc::new(Goals { service }));
    }
    if let Some(service) = boot.services.get::<Arc<heddle_todo::TodoService>>("todo") {
        harness.todos = Some(Arc::new(Todos { service }));
    }
    if let Some(service) = boot
        .services
        .get::<Arc<heddle_team::service::TeamService>>("team")
    {
        harness.team = Some(Arc::new(Team { service }));
    }
    // The live-turn registry: a Stop also reaches the turns the rows start themselves (#93).
    if let Some(turns) = boot.services.get::<heddle_agent::TurnRegistry>("turns") {
        harness.interrupter = Some(Arc::new(LiveTurns { turns }));
    }
    // The approvals row: the page becomes the answerer while the server runs, and every question the
    // service publishes reaches /api/events as an `approval` frame (the server relays `subscribe`).
    if let Some(service) = boot
        .services
        .get::<Arc<heddle_sandbox::ApprovalService>>("approvals")
    {
        harness.approvals = Some(Arc::new(Approvals { service }));
    }
    if let Some(preference) = boot
        .services
        .get::<Arc<heddle_config::LocalePreference>>("locale")
    {
        harness.locale = Some(*preference);
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
    let mut harness = harness(&boot, invocation.cwd.clone());
    compose_uploads(&mut harness, &heddle_config::heddle_home(&invocation.env));
    let runtime = crate::runtime::tokio();
    // The boot's goal-driver row follows the sessions' events in every process; web adds only the
    // start sweep (`boot_notes`), which resumes the goals a previous process left active.
    // A switch made while a turn runs lands on that turn's next model call.
    let selection_rule = follow_session_selection(&boot, Arc::clone(&harness.models));
    let notes = runtime.block_on(boot_notes(&boot));
    let shutdown = heddle_tools::CancellationToken::new();
    let context = heddle_server::command::Context {
        cwd: invocation.cwd.clone(),
        harness: &harness,
        // The hub the session store was given its listener over at boot.
        events: boot.services.get::<heddle_server::EventHub>("event-hub"),
        routers: page_routers(&boot, &invocation.env, args.endpoint.as_deref())
            .into_iter()
            .chain(settings_router(args, invocation))
            .collect(),
        views: page_views(&boot, &invocation.env),
        asset_roots: asset_roots(&boot.anchor, &invocation.cwd),
        secret_path: Some(heddle_config::heddle_home(&invocation.env).join("web-secret")),
        notes,
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
    if let Some((service, id)) = selection_rule {
        service.remove_hooks(id);
    }
    boot.dispose();
    if code == 0 {
        Exit::Success
    } else {
        Exit::Failure
    }
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

/// The feature routers mounted behind the door: the files panel, the trajectory's log and stats, and the
/// composer's model switcher and context view (`/api/endpoints`, `POST /api/sessions/{id}/model`,
/// `/api/context`), which is what lets the page show and choose a model.
fn page_routers(
    boot: &Boot,
    env: &heddle_config::Env,
    nominated: Option<&str>,
) -> Vec<axum::Router> {
    // The plugin inventory describes the tree itself, so it answers whether or not a session store loaded.
    let mut routers = vec![plugin_inventory_router(boot)];
    let Some(host) = page_host(boot, env) else {
        return routers;
    };
    routers.push(heddle_web_files::routes::mount(
        axum::Router::new(),
        host.clone(),
    ));
    routers.push(heddle_web_trajectory::routes::router(host.clone()));
    if let Some(composer) = composer_host(boot, &host, nominated) {
        routers.push(heddle_web_composer::router(composer));
    }
    // The reminder routes: DSH's remote `schedule` namespace; 503 when the profile has no schedule row.
    routers.push(heddle_schedule::http::router(
        boot.services
            .get::<Arc<heddle_schedule::SchedulePlugin>>("schedule")
            .map(|schedule| Arc::clone(&schedule.service)),
    ));
    // The background-job routes: DSH's job controller (list, follow, kill); 503 when the profile has no jobs row.
    routers.push(heddle_jobs::http::router(
        boot.services
            .get::<Arc<heddle_jobs::JobsPlugin>>("jobs")
            .map(|jobs| jobs.registry.clone()),
    ));
    routers
}

/// `GET /api/plugin-inventory`: DSH's read-only `pluginInventory/list` over the booted tree, built by
/// `heddle_config::plugin_inventory` from the composed rows and the loader's entries.
///
/// Read once, when the server is composed, and that is the live answer: this loader starts every row
/// synchronously and reloads none, and `web` refuses a tree with an entry still pending, so the phases
/// [`crate::boot::load`] left are the phases for the server's whole life. They change only at
/// [`Boot::dispose`], after the server has stopped. (The TypeScript build reads its Cordis loader on every
/// request, because a Cordis fiber can change phase while the server runs.)
fn plugin_inventory_router(boot: &Boot) -> axum::Router {
    let snapshot = Arc::new(plugin_inventory_of(boot));
    axum::Router::new().route(
        "/api/plugin-inventory",
        axum::routing::get(move || {
            let snapshot = Arc::clone(&snapshot);
            async move { heddle_server::respond::json(axum::http::StatusCode::OK, &*snapshot) }
        }),
    )
}

/// The inventory of a booted tree: its composed rows, paired with the loader's entries and their states.
fn plugin_inventory_of(boot: &Boot) -> heddle_config::PluginInventorySnapshot {
    let loaded: Vec<_> = boot
        .entries
        .iter()
        .map(|entry| (entry.id.clone(), fiber_phase(entry.state)))
        .collect();
    heddle_config::plugin_inventory(&boot.rows, &loaded)
}

/// A loader state as the inventory spells it: DSH's `FIBER_PHASE`, where a disposed entry has no phase.
fn fiber_phase(state: FiberState) -> Option<heddle_config::PluginFiberPhase> {
    use heddle_config::PluginFiberPhase as Phase;
    match state {
        FiberState::Pending => Some(Phase::Pending),
        FiberState::Loading => Some(Phase::Loading),
        FiberState::Active => Some(Phase::Active),
        FiberState::Failed => Some(Phase::Failed),
        FiberState::Disposed => None,
        FiberState::Unloading => Some(Phase::Unloading),
    }
}

/// `GET /api/settings`, `GET /api/settings/{ns}` and `POST /api/settings/{ns}`: the active profile's patch
/// as a writable surface, as DSH's settings controller offers it. Every answer is `heddle-config`'s
/// ([`heddle_config::handle_settings_request`]); the service is built from the same layer options, in-memory
/// layers and catalog the boot used, and it is mounted behind the door like the other feature routers.
fn settings_router(args: &Args, invocation: &Invocation) -> Option<axum::Router> {
    let options = crate::cli::layer_options(args, &invocation.cwd, &invocation.env);
    let overrides: Vec<heddle_config::NamedLayer> =
        crate::cli::root_overrides(args, &invocation.cwd)
            .into_iter()
            .collect();
    let catalog =
        crate::builtins::BuiltinCatalog::new(invocation.env.clone(), invocation.cwd.clone());
    let service = heddle_config::SettingsService::new(
        &options,
        &overrides,
        invocation.env.clone(),
        Box::new(catalog),
    )
    .ok()?;
    Some(
        axum::Router::new()
            .route("/api/settings", axum::routing::any(settings_answer))
            .route("/api/settings/{ns}", axum::routing::any(settings_answer))
            .with_state(Arc::new(service)),
    )
}

/// One settings request, answered off the async runtime because it reads and writes the profile patch.
async fn settings_answer(
    axum::extract::State(service): axum::extract::State<Arc<heddle_config::SettingsService>>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path = uri.path().to_owned();
    let answer = tokio::task::spawn_blocking(move || {
        heddle_config::handle_settings_request(&service, method.as_str(), &path, &body)
    })
    .await
    .ok()
    .flatten();
    match answer {
        Some(response) => (
            axum::http::StatusCode::from_u16(response.status)
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
            axum::Json(response.body),
        )
            .into_response(),
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

/// What the composer's routes read: the booted session store, the model service and the sandbox.
struct Composer {
    sessions: Arc<heddle_session::SessionService>,
    models: Arc<heddle_llm::ModelService>,
    sandbox: Option<Arc<heddle_sandbox::SandboxService>>,
    /// `--endpoint`, the endpoint the page offers as the default.
    nominated: Option<String>,
    /// The context row's service: what a request would carry, for `/api/context`.
    context: Option<Arc<heddle_context::ContextService<heddle_session::SessionStore>>>,
    /// The tools a request would describe, measured as part of the context.
    tools: Option<Arc<heddle_tools::ToolRegistry>>,
}

fn composer_host(boot: &Boot, host: &PageHost, nominated: Option<&str>) -> Option<Arc<Composer>> {
    Some(Arc::new(Composer {
        sessions: Arc::clone(&host.sessions),
        models: boot
            .services
            .get::<Arc<heddle_llm::ModelService>>("model")?,
        sandbox: boot
            .services
            .get::<Arc<heddle_sandbox::SandboxService>>("sandbox"),
        nominated: nominated.map(str::to_owned),
        context: boot
            .services
            .get::<Arc<heddle_context::ContextService<heddle_session::SessionStore>>>("context"),
        tools: host.tools.clone(),
    }))
}

impl heddle_web_composer::session::SessionLookup for Composer {
    fn session_events(&self, id: &str) -> Option<Vec<Value>> {
        let handle = self.sessions.open(id)?;
        let events = self.sessions.events(&handle).ok()?;
        Some(events.iter().map(|event| event.to_value()).collect())
    }
}

impl heddle_web_composer::status::StatusHost for Composer {
    fn sandbox_mode(&self) -> String {
        self.sandbox
            .as_ref()
            .map(|sandbox| sandbox.mode().to_string())
            .unwrap_or_else(|| "workspace-write".to_owned())
    }

    fn workspace_root(&self) -> Option<String> {
        self.sandbox
            .as_ref()
            .map(|sandbox| sandbox.workspace_root().to_string_lossy().into_owned())
    }
}

impl heddle_web_composer::model_switcher::ModelHost for Composer {
    fn describe_endpoints(&self) -> heddle_web_composer::model_switcher::EndpointListing {
        let nominated = self.nominated.clone().or_else(|| self.models.nominated());
        let view = heddle_config::describe_endpoints(&self.models.list(), nominated.as_deref());
        heddle_web_composer::model_switcher::EndpointListing {
            endpoints: view
                .endpoints
                .into_iter()
                .filter_map(|endpoint| endpoint.as_object().cloned())
                .collect(),
            default: view.default,
        }
    }

    /// The window the provider's model list reports for an endpoint that declares none, read once and
    /// cached by the model service (`contextWindowFromModelList`); the page's context gauge needs it.
    fn discover_context_window(
        &self,
        endpoint: &str,
    ) -> impl std::future::Future<Output = Option<u64>> + Send {
        let models = Arc::clone(&self.models);
        let endpoint = endpoint.to_owned();
        async move {
            let config = models.endpoint(&endpoint)?;
            models
                .model_lists()
                .context_window(
                    &config,
                    &heddle_llm::model_info::ModelInfoOptions::default(),
                )
                .await
        }
    }

    fn endpoint_names(&self) -> Vec<String> {
        self.models.names()
    }

    fn selection_problem(
        &self,
        endpoint: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Option<String> {
        match self.models.endpoint(endpoint) {
            Some(config) => heddle_config::selection_problem(&config, model, reasoning_effort),
            None => Some(format!("unknown endpoint '{endpoint}'")),
        }
    }

    fn set_session_model(
        &self,
        id: &str,
        choice: &heddle_web_composer::model_switcher::ModelChoice,
    ) -> Option<Value> {
        self.sessions
            .set_model(
                id,
                heddle_session::ModelSelection {
                    endpoint: choice.endpoint.clone(),
                    model: choice.model.clone(),
                    reasoning_effort: choice.reasoning_effort.clone(),
                },
            )
            .ok()
            .flatten()
            .map(|meta| meta.to_value())
    }
}

impl heddle_web_composer::context_view::ContextHost for Composer {
    /// `/api/context` answers only when the profile loads the context row.
    fn has_context(&self) -> bool {
        self.context.is_some()
    }

    /// web.ts: the session's own folder, else the sandbox's workspace root.
    fn session_cwd(&self, id: &str) -> String {
        self.sessions
            .open(id)
            .and_then(|handle| self.sessions.folder(&handle))
            .or_else(|| {
                self.sandbox
                    .as_ref()
                    .map(|sandbox| sandbox.workspace_root().to_string_lossy().into_owned())
            })
            .unwrap_or_default()
    }

    /// What a request would carry right now (`context.assemble`): the instructions, the measured
    /// surface against the endpoint's window, and the messages, with the tools described.
    fn assemble_context(
        &self,
        id: &str,
        request: &heddle_web_composer::context_view::AssembleRequest,
    ) -> heddle_web_composer::context_view::ContextAssembly {
        use heddle_web_composer::context_view::{ContextAssembly, ContextMessage};
        let (Some(context), Some(handle)) = (self.context.as_ref(), self.sessions.open(id)) else {
            return ContextAssembly::default();
        };
        let tools = self
            .tools
            .as_ref()
            .map(|tools| tools.describe())
            .unwrap_or_default();
        let options = heddle_context::service::AssembleOptions {
            cwd: std::path::Path::new(&request.cwd),
            tools: &tools,
            system: None,
            endpoint: request.endpoint.as_deref(),
            model: request.model.as_deref(),
        };
        let Ok(report) = context.assemble(&handle, &options) else {
            return ContextAssembly::default();
        };
        ContextAssembly {
            instructions: report
                .instructions
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            estimated_tokens: report.estimated_tokens,
            context_window: report.context_window,
            threshold_tokens: report.threshold_tokens,
            pruned: report.pruned,
            compacted: report.compacted,
            messages: report
                .messages
                .iter()
                .map(|message| ContextMessage {
                    role: to_json(message.role)
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    tool_call_id: message.tool_call_id.clone(),
                    text: heddle_session::text_of(&message.content),
                })
                .collect(),
        }
    }

    /// The session's surface: which events a request is built from, and the spans a summary stands in for.
    fn surface(&self, id: &str) -> heddle_web_composer::context_view::Surface {
        use heddle_web_composer::context_view::{Surface, SurfaceReplacement};
        let Some(state) = self
            .sessions
            .open(id)
            .and_then(|handle| self.sessions.surface(&handle).ok())
        else {
            return Surface::default();
        };
        Surface {
            nodes: state.nodes.clone(),
            replacements: state
                .replacements
                .iter()
                .map(|replacement| SurfaceReplacement {
                    seq: replacement.seq,
                    start_seq: replacement.start_seq,
                    end_seq: replacement.end_seq,
                    shadowed_seqs: replacement.shadowed_seqs.clone(),
                })
                .collect(),
        }
    }
}

/// The composer's router mounts no turn-control route (steer and stop are the server's, D-039), so
/// these are never called through it; they answer as a session with no running turn would.
impl heddle_web_composer::turn_control::TurnControlHost for Composer {
    fn is_running(&self, _id: &str) -> bool {
        false
    }

    fn abort_session(&self, _id: &str) -> u64 {
        0
    }

    fn read_attachments(&self, _raw: Option<&Value>) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }

    fn record_user_content(&self, _id: &str, _content: Vec<Value>) {}
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

    /// The upload route serves a file only to a session whose log references it, so it reads the log the
    /// session view draws from.
    fn session_events(&self, id: &str) -> Option<Vec<Value>> {
        heddle_web_composer::SessionLookup::session_events(self, id)
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

    /// The endpoint a turn uses when neither the request nor the session names one (`defaultEndpoint`):
    /// the configuration's nominated default when it exists, else the first endpoint, as
    /// `src/llm/service.ts` answers. Only the nominated one left a session with no recorded endpoint
    /// with none at all, and its follow-up turn was refused.
    fn default_endpoint(&self) -> Option<String> {
        self.service.default_endpoint(None)
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

/// The workspace row's service as the server's port. The sessions a row counts and a removal checks
/// come from the booted store itself, the same records the server lists.
struct Workspaces {
    service: Arc<heddle_workspace::WorkspaceService>,
    sessions: Arc<heddle_session::SessionService>,
}

fn path_text(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

fn refusal(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::new(error.to_string())
}

/// A workspace refusal with its code when it has one, so the route answers it: a folder the tree may not
/// read is `workspace-file/unreadable`, a `400` (#106).
fn coded_refusal(error: heddle_workspace::WorkspaceError) -> ServiceError {
    match error.code() {
        Some(code) => ServiceError::with_code(error.to_string(), code),
        None => refusal(error),
    }
}

impl heddle_server::services::WorkspaceService for Workspaces {
    fn owns(&self, path: &std::path::Path) -> bool {
        self.service.owner(&path_text(path)).is_some()
    }

    fn tree(
        &self,
        path: Option<&std::path::Path>,
        archived: heddle_server::services::ArchivedFilter,
        _sessions: &[heddle_server::services::SessionMeta],
    ) -> Result<Value, ServiceError> {
        use heddle_server::services::ArchivedFilter as Server;
        use heddle_workspace::ArchivedFilter as Workspace;
        let input = heddle_workspace::TreeInput {
            roots: self
                .service
                .list()
                .iter()
                .map(heddle_workspace::TreeRoot::from)
                .collect(),
            sessions: self.sessions.list(),
            generated: self.service.generated().to_vec(),
            archived: match archived {
                Server::Hide => Workspace::Hide,
                Server::Show => Workspace::Show,
                Server::Only => Workspace::Only,
            },
        };
        let path = path.map(path_text);
        let node = heddle_workspace::tree(path.as_deref(), &input).map_err(coded_refusal)?;
        serde_json::to_value(node).map_err(refusal)
    }

    fn add(
        &self,
        path: &std::path::Path,
        name: Option<&str>,
    ) -> Result<(Value, bool), ServiceError> {
        let addition = self.service.add(&path_text(path), name).map_err(refusal)?;
        let record = serde_json::to_value(&addition.record).map_err(refusal)?;
        Ok((record, addition.created))
    }

    fn find(&self, id: &str) -> bool {
        self.service.find(id).is_some()
    }

    fn remove(
        &self,
        id: &str,
        _sessions: &[heddle_server::services::SessionMeta],
    ) -> Result<Value, ServiceError> {
        // `force`: the page's Delete workspace removes the registration even when sessions stay behind
        // (DSH's rule; they show under the nearest root above, else Ungrouped). The CLI keeps the refusal.
        let removal = self
            .service
            .remove(id, &self.sessions.list(), true)
            .map_err(refusal)?;
        serde_json::to_value(&removal).map_err(refusal)
    }

    fn rename(&self, id: &str, title: &str) -> Result<Option<Value>, ServiceError> {
        let renamed = self
            .service
            .rename(id, title)
            .map_err(|error| match error {
                heddle_workspace::WorkspaceError::NameConflict(_) => {
                    ServiceError::with_code(error.to_string(), "workspace/name-conflict")
                }
                other => refusal(other),
            })?;
        match renamed {
            Some(record) => serde_json::to_value(&record).map(Some).map_err(refusal),
            None => Ok(None),
        }
    }

    fn ensure_owner(&self, folder: &std::path::Path) {
        let _ = self.service.ensure_owner(&path_text(folder));
    }

    fn views(
        &self,
        _sessions: &[heddle_server::services::SessionMeta],
    ) -> Result<Value, ServiceError> {
        // The booted store's own records, as `tree` and `remove` read them.
        serde_json::to_value(self.service.views(&self.sessions.list())).map_err(refusal)
    }

    fn insert_before(&self, id: &str, before: Option<&str>) -> Result<Vec<String>, ServiceError> {
        self.service
            .insert_before(id, before)
            .map_err(|error| match error {
                heddle_workspace::WorkspaceError::OrderInvalid(missing) => {
                    heddle_server::services::workspace_not_found(&missing)
                }
                other => refusal(other),
            })
    }
}

/// The attachment reader a turn uses: the paths the page uploaded (`POST /api/uploads`, under
/// `<heddle home>/uploads`) become the typed parts the model receives.
pub fn compose_uploads(harness: &mut Harness, home: &std::path::Path) {
    let uploads = home.join("uploads");
    harness.attachments = Some(heddle_server::services::attachment_reader(
        move |raw: Option<&Value>| {
            heddle_web_files::attachments::read_attachments(&uploads, raw)
                .map(|parts| parts.iter().map(to_json).collect())
                .map_err(|error| error.to_string())
        },
    ));
}

/// What the boot reports before the URL, in the TypeScript order: the teams the team row recovered
/// (`recovered N team(s) (S settled, D delivered[, F failed])`). Each is printed as `heddle web: <note>`.
async fn boot_notes(boot: &Boot) -> Vec<String> {
    let mut notes = Vec::new();
    // Goals first, as runWeb prints them: every session whose goal is runnable is requested once, and
    // its chain runs on this runtime without being awaited here.
    if let (Some(driver), Some(sessions)) = (
        boot.services
            .get::<Arc<heddle_goal::GoalDriver>>("goalDriver"),
        boot.services
            .get::<Arc<heddle_session::SessionService>>("session"),
    ) {
        let ids: Vec<String> = sessions
            .list()
            .iter()
            .map(|meta| meta.id().to_owned())
            .collect();
        let resumed = driver.resume_at_start(&ids);
        if resumed.requested > 0 {
            notes.push(format!("resuming {} active goal(s)", resumed.requested));
        }
    }
    if let Some(team) = boot
        .services
        .get::<Arc<heddle_team::service::TeamService>>("team")
        && let Some(note) = heddle_team::command::web_start_note(&team).await
    {
        notes.push(note);
    }
    // Reminders that came due are delivered by the server only, after the sweeps above (DSH's dsh-schedule); a
    // committed reminder write reaches the page's subscribers as `event: schedule`.
    if let Some(schedule) = boot
        .services
        .get::<Arc<heddle_schedule::SchedulePlugin>>("schedule")
    {
        if let Some(hub) = boot.services.get::<heddle_server::EventHub>("event-hub") {
            schedule.service.on_change(Arc::new(move || {
                hub.publish(heddle_server::SseFrame::new(
                    "schedule",
                    &serde_json::json!({}),
                ));
                Ok(())
            }));
        }
        schedule.start_delivery();
    }
    // A background job's lifecycle changed, so the page's job views refresh (DSH's job-list frame on each change).
    if let (Some(jobs), Some(hub)) = (
        boot.services.get::<Arc<heddle_jobs::JobsPlugin>>("jobs"),
        boot.services.get::<heddle_server::EventHub>("event-hub"),
    ) {
        jobs.on_change(move || {
            hub.publish(heddle_server::SseFrame::new("jobs", &serde_json::json!({})));
        });
    }
    notes
}

/// The `model/request` rule while the server runs (web.ts's waterfall): a running turn's next model call
/// is answered by the session's current record, so a model switched from the page takes effect on the
/// turn's next step. What cannot be enforced is left as the turn asked
/// (`heddle_server::running_turn_selection`).
struct SessionSelectionRule {
    sessions: Arc<heddle_session::SessionService>,
    models: Arc<dyn ServerModels>,
}

impl heddle_llm::ModelHooks for SessionSelectionRule {
    fn request(
        &self,
        _service: &heddle_llm::ModelService,
        _request: &heddle_llm::GenerateRequest,
        next: &mut dyn FnMut() -> Result<heddle_llm::GenerateRequest, heddle_llm::ModelError>,
    ) -> Result<heddle_llm::GenerateRequest, heddle_llm::ModelError> {
        let mut resolved = next()?;
        let Some(meta) = resolved
            .session_id
            .as_deref()
            .and_then(|id| self.sessions.meta(id))
        else {
            return Ok(resolved);
        };
        let recorded = heddle_server::selection::SessionSelection {
            endpoint: meta.endpoint().map(str::to_owned),
            model: meta.model().map(str::to_owned),
            reasoning_effort: meta.reasoning_effort().map(str::to_owned),
        };
        let current = heddle_server::selection::RequestSelection {
            endpoint: resolved.endpoint.clone(),
            model: resolved.model.clone(),
            reasoning_effort: resolved.reasoning_effort.clone(),
        };
        let chosen =
            heddle_server::running_turn_selection(&current, &recorded, self.models.as_ref());
        resolved.endpoint = chosen.endpoint;
        resolved.model = chosen.model;
        resolved.reasoning_effort = chosen.reasoning_effort;
        Ok(resolved)
    }
}

/// Register [`SessionSelectionRule`] on the booted model service; the caller removes it when the server
/// stops. `None` without a model service or a session store.
fn follow_session_selection(
    boot: &Boot,
    models: Arc<dyn ServerModels>,
) -> Option<(Arc<heddle_llm::ModelService>, heddle_llm::service::HooksId)> {
    let service = boot
        .services
        .get::<Arc<heddle_llm::ModelService>>("model")?;
    let sessions = boot
        .services
        .get::<Arc<heddle_session::SessionService>>("session")?;
    let id = service.add_hooks(Arc::new(SessionSelectionRule { sessions, models }));
    Some((service, id))
}

fn to_json(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The goal row's service as the server's port.
struct Goals {
    service: Arc<heddle_goal::GoalService>,
}

fn goal_refusal(error: heddle_goal::GoalError) -> ServiceError {
    match error.code() {
        Some(code) => ServiceError::with_code(error.to_string(), code.as_str()),
        None => ServiceError::new(error.to_string()),
    }
}

impl heddle_server::services::GoalService for Goals {
    fn get(&self, session: &str) -> Option<Value> {
        self.service.get(session).ok().flatten().map(to_json)
    }

    fn act(
        &self,
        session: &str,
        action: heddle_server::services::GoalAction,
    ) -> Result<heddle_server::services::GoalAnswer, ServiceError> {
        use heddle_server::services::{GoalAction, GoalAnswer};
        let of = |goal: &heddle_server::services::GoalRef| heddle_goal::GoalRef {
            id: goal.id.clone(),
            revision: goal.revision,
        };
        let rounds = |rounds: Option<u64>| rounds.map(|rounds| rounds as f64);
        let view = match action {
            GoalAction::Create {
                objective,
                max_goal_rounds,
            } => self.service.create(
                session,
                heddle_goal::CreateGoal {
                    objective,
                    max_goal_rounds: rounds(max_goal_rounds),
                },
            ),
            GoalAction::Edit {
                goal,
                objective,
                max_goal_rounds,
            } => self.service.edit(
                session,
                &of(&goal),
                heddle_goal::EditGoal {
                    objective,
                    max_goal_rounds: rounds(max_goal_rounds),
                },
            ),
            GoalAction::Pause(goal) => self.service.pause(session, &of(&goal)),
            GoalAction::Resume(goal) => self.service.resume(session, &of(&goal)),
            GoalAction::Complete(goal) => self.service.complete(session, &of(&goal)),
            GoalAction::Blocked { goal, reason } => {
                self.service.block(session, &of(&goal), &reason)
            }
            GoalAction::Clear(goal) => {
                return self
                    .service
                    .clear(session, &of(&goal))
                    .map(|cleared| GoalAnswer::Cleared(to_json(cleared)))
                    .map_err(goal_refusal);
            }
        };
        view.map(|view| GoalAnswer::Goal(to_json(view)))
            .map_err(goal_refusal)
    }
}

/// The todo row's service as the server's port.
struct Todos {
    service: Arc<heddle_todo::TodoService>,
}

/// The agent runtime's live-turn registry as the server's interrupter: what `turns.abort` is in web.ts's stop route.
struct LiveTurns {
    turns: heddle_agent::TurnRegistry,
}

impl heddle_server::services::TurnInterrupter for LiveTurns {
    fn interrupt(&self, session: &str) -> bool {
        self.turns.abort(session, Some("stopped by the user"))
    }
}

impl heddle_server::services::TodoService for Todos {
    fn get(&self, session: &str) -> Option<Value> {
        self.service.get(session).ok().flatten().map(to_json)
    }
}

/// The team row's service as the server's port: one fold, so roster, board and mailbox describe one
/// moment; a log the fold refuses is the route's 500.
struct Team {
    service: Arc<heddle_team::service::TeamService>,
}

impl heddle_server::services::TeamService for Team {
    fn view(&self, session: &str) -> Result<heddle_server::services::TeamView, ServiceError> {
        let view = heddle_team::api::team_view(&self.service, session)
            .map_err(|error| ServiceError::new(error.to_string()))?;
        Ok(heddle_server::services::TeamView {
            lead: to_json(&view.lead),
            members: to_json(&view.members),
            tasks: to_json(&view.tasks),
            messages: to_json(&view.messages),
            delivered: to_json(&view.delivered),
        })
    }
}

/// The approval service the sandbox row provides, as the server's port.
struct Approvals {
    service: Arc<heddle_sandbox::ApprovalService>,
}

impl ServerApprovals for Approvals {
    fn attach_answerer(&self) -> Box<dyn FnOnce() + Send> {
        let guard = self.service.attach_answerer();
        Box::new(move || guard.detach())
    }

    fn pending_requests(&self) -> Vec<Value> {
        self.service
            .pending_requests()
            .iter()
            .filter_map(|request| serde_json::to_value(request).ok())
            .collect()
    }

    fn answer(&self, id: &str, outcome: ApprovalOutcome) -> bool {
        let word = match outcome {
            ApprovalOutcome::AllowedOnce => "allowed-once",
            ApprovalOutcome::Rejected => "rejected",
            ApprovalOutcome::Cancelled => "cancelled",
        };
        heddle_sandbox::Answer::parse(word).is_some_and(|answer| self.service.answer(id, answer))
    }

    /// Every question the service publishes from now on; a lagging receiver skips what it missed (the
    /// page repaints from `pending_requests`), and the stream ends when the service is gone.
    fn subscribe(&self) -> Option<futures::stream::BoxStream<'static, Value>> {
        let receiver = self.service.subscribe();
        Some(Box::pin(futures::stream::unfold(
            receiver,
            |mut receiver| async move {
                loop {
                    match receiver.recv().await {
                        Ok(request) => {
                            let value = serde_json::to_value(&request).unwrap_or(Value::Null);
                            return Some((value, receiver));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                    }
                }
            },
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::Services;
    use serde_json::json;

    #[tokio::test]
    async fn the_approvals_row_becomes_the_server_approval_service() {
        let service = Arc::new(heddle_sandbox::ApprovalService::new(
            heddle_sandbox::ApprovalsConfig::default(),
        ));
        let mut boot = empty_boot();
        boot.services.provide("approvals", Arc::clone(&service));
        let harness = harness(&boot, PathBuf::from("/work"));
        let approvals = harness.approvals.expect("the approvals row is composed");

        assert!(!service.can_answer());
        let detach = approvals.attach_answerer();
        assert!(
            service.can_answer(),
            "the page is the answerer while the server runs"
        );
        detach();
        assert!(!service.can_answer());

        assert!(approvals.pending_requests().is_empty());
        assert!(
            !approvals.answer(
                "approval-00000000-0000-0000-0000-000000000000",
                ApprovalOutcome::AllowedOnce
            ),
            "nothing is waiting under that id"
        );
        assert!(
            approvals.subscribe().is_some(),
            "questions are relayed by the server"
        );
    }

    fn composer_boot(root: &std::path::Path) -> Boot {
        let mut boot = empty_boot();
        let sessions = Arc::new(heddle_session::SessionService::new(
            &heddle_session::SessionConfig {
                root: Some(root.to_string_lossy().into_owned()),
            },
            &heddle_config::Env::default(),
            None,
        ));
        boot.services.provide("session", sessions);
        boot.services.provide(
            "model",
            Arc::new(
                heddle_llm::ModelService::new(heddle_config::default_endpoints())
                    .expect("the default endpoints are valid"),
            ),
        );
        boot
    }

    #[test]
    fn the_composer_lists_the_booted_endpoints_and_switches_a_session() {
        use heddle_web_composer::model_switcher::{ModelChoice, ModelHost};
        let root = std::env::temp_dir().join(format!(
            "heddle-web-composer-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let boot = composer_boot(&root);
        let host = page_host(&boot, &heddle_config::Env::default()).expect("a session store");
        let composer = composer_host(&boot, &host, Some("scripted")).expect("a model service");

        let listing = composer.describe_endpoints();
        assert_eq!(listing.default.as_deref(), Some("scripted"));
        assert_eq!(listing.endpoints.len(), 1);
        assert_eq!(listing.endpoints[0]["name"], "scripted");
        assert_eq!(composer.endpoint_names(), vec!["scripted".to_owned()]);
        assert!(composer.selection_problem("scripted", None, None).is_none());
        assert_eq!(
            composer.selection_problem("absent", None, None).as_deref(),
            Some("unknown endpoint 'absent'")
        );

        let id = host
            .sessions
            .start(heddle_session::StartOptions::default())
            .unwrap()
            .id;
        let meta = composer
            .set_session_model(
                &id,
                &ModelChoice {
                    endpoint: "scripted".into(),
                    model: None,
                    reasoning_effort: None,
                },
            )
            .expect("a known session");
        assert_eq!(meta["endpoint"], "scripted");
        assert_eq!(
            page_routers(&boot, &heddle_config::Env::default(), None).len(),
            6,
            "the plugin inventory, files, trajectory, the composer, the reminder routes and the job routes (each 503 without its row)"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_settings_routes_write_the_active_profiles_patch() {
        let root = std::env::temp_dir().join(format!(
            "heddle-web-settings-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let profile = root.join("home/profiles/dev");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join("cordis.yml"),
            "- insert:\n    - id: tools\n      name: ./src/plugins/tools.ts\n      config: {bashTimeoutMs: 30000}\n",
        )
        .unwrap();
        let invocation = Invocation {
            argv: Vec::new(),
            env: heddle_config::Env::default()
                .with("HEDDLE_HOME", root.join("home").to_string_lossy())
                .with("HOME", root.to_string_lossy()),
            cwd: root.clone(),
        };
        let args = Args {
            profile: Some("dev".into()),
            ..Args::default()
        };
        let router = settings_router(&args, &invocation).expect("a settings router");
        drop(router);
        let options = crate::cli::layer_options(&args, &invocation.cwd, &invocation.env);
        let service = Arc::new(
            heddle_config::SettingsService::new(
                &options,
                &[],
                invocation.env.clone(),
                Box::new(crate::builtins::BuiltinCatalog::new(
                    invocation.env.clone(),
                    invocation.cwd.clone(),
                )),
            )
            .unwrap(),
        );
        let call = |method: axum::http::Method, path: &str, body: &str| {
            let service = Arc::clone(&service);
            let response = crate::runtime::tokio().block_on(settings_answer(
                axum::extract::State(service),
                method,
                path.parse().unwrap(),
                axum::body::Bytes::from(body.to_owned()),
            ));
            let status = response.status().as_u16();
            let bytes = crate::runtime::tokio()
                .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
                .unwrap();
            (
                status,
                serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
            )
        };
        let (status, view) = call(axum::http::Method::GET, "/api/settings", "");
        assert_eq!(status, 200, "{view}");
        assert_eq!(view["writable"], true);
        let (status, entry) = call(
            axum::http::Method::POST,
            "/api/settings/tools",
            r#"{"update": {"bashTimeoutMs": 60000}, "expectedRevision": 1}"#,
        );
        assert_eq!(status, 200, "{entry}");
        assert_eq!(entry["value"]["bashTimeoutMs"], 60000);
        let written = std::fs::read_to_string(profile.join("heddle.patch.yml")).unwrap();
        assert!(written.contains(heddle_config::SETTINGS_BEGIN), "{written}");
        let (status, stale) = call(
            axum::http::Method::POST,
            "/api/settings/tools",
            r#"{"update": {"bashTimeoutMs": 1}, "expectedRevision": 1}"#,
        );
        assert_eq!(status, 409, "{stale}");
        assert_eq!(stale["code"], "settings-conflict");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_workspace_row_becomes_the_server_workspace_service() {
        let root = std::env::temp_dir().join(format!(
            "heddle-web-workspaces-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let project = std::fs::canonicalize(&project).unwrap();
        let mut boot = composer_boot(&root.join("sessions"));
        boot.services.provide(
            "workspace",
            Arc::new(heddle_workspace::WorkspaceService::new(
                &heddle_workspace::WorkspaceConfig {
                    file: Some(root.join("workspaces.json").to_string_lossy().into_owned()),
                    generated: Vec::new(),
                },
                &heddle_config::Env::default(),
            )),
        );
        let harness = harness(&boot, root.clone());
        let workspaces = harness.workspaces.expect("the workspace row is composed");

        assert!(!workspaces.owns(&project), "nothing is a root yet");
        let (record, created) = workspaces.add(&project, Some("project")).unwrap();
        assert!(created);
        assert_eq!(record["path"], project.to_string_lossy().as_ref());
        assert!(
            workspaces.owns(&project.join("src")),
            "a path under a root is owned"
        );
        let tree = workspaces
            .tree(None, heddle_server::services::ArchivedFilter::Hide, &[])
            .unwrap();
        assert!(tree.to_string().contains("project"), "{tree}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_settled_answer_is_rendered_by_the_files_crate_markdown() {
        let harness = harness(&empty_boot(), PathBuf::from("/work"));
        let markdown = harness.markdown.expect("the renderer is always composed");
        let html = markdown.render("# Title\n\nA *settled* answer.");
        assert!(html.contains("<h1"), "{html}");
        assert!(html.contains("<em>settled</em>"), "{html}");
    }

    #[test]
    fn the_stats_and_the_uploads_are_composed() {
        let mut harness = harness(&empty_boot(), PathBuf::from("/work"));
        let stats = harness
            .stats
            .clone()
            .expect("the stats projector is composed");
        assert!(stats.stats("s", &[]).is_object());
        let home = std::env::temp_dir().join(format!("heddle-web-uploads-{}", std::process::id()));
        compose_uploads(&mut harness, &home);
        let reader = harness
            .attachments
            .expect("the attachment reader is composed");
        assert_eq!(reader.read(None), Ok(Vec::new()), "no attachments is none");
        assert!(reader.read(Some(&serde_json::json!("not a list"))).is_err());
    }

    #[test]
    fn a_running_turn_takes_the_model_its_session_records_now() {
        use heddle_llm::ModelHooks;
        let root = std::env::temp_dir().join(format!(
            "heddle-web-selection-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sessions = Arc::new(heddle_session::SessionService::new(
            &heddle_session::SessionConfig {
                root: Some(root.to_string_lossy().into_owned()),
            },
            &heddle_config::Env::default(),
            None,
        ));
        let mut endpoints = heddle_config::default_endpoints();
        let mut second = endpoints[0].clone();
        second.name = "second".into();
        endpoints.push(second);
        let service = Arc::new(heddle_llm::ModelService::new(endpoints).unwrap());
        let rule = SessionSelectionRule {
            sessions: Arc::clone(&sessions),
            models: Arc::new(Models {
                service: Arc::clone(&service),
            }),
        };
        let switched = sessions
            .start(heddle_session::StartOptions::default())
            .unwrap()
            .id;
        sessions
            .set_model(
                &switched,
                heddle_session::ModelSelection {
                    endpoint: "second".into(),
                    model: None,
                    reasoning_effort: None,
                },
            )
            .unwrap();
        let untouched = sessions
            .start(heddle_session::StartOptions::default())
            .unwrap()
            .id;
        let request = |session: &str| -> heddle_llm::GenerateRequest {
            serde_json::from_value(serde_json::json!({
                "endpoint": "scripted",
                "messages": [],
                "sessionId": session,
            }))
            .unwrap()
        };
        let asked = request(&switched);
        let resolved = rule
            .request(&service, &asked, &mut || Ok(asked.clone()))
            .unwrap();
        assert_eq!(
            resolved.endpoint, "second",
            "the switch lands on the next call"
        );
        let asked = request(&untouched);
        let resolved = rule
            .request(&service, &asked, &mut || Ok(asked.clone()))
            .unwrap();
        assert_eq!(
            resolved.endpoint, "scripted",
            "a session with no record keeps the request"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn a_boot_without_goal_todo_or_team_rows_composes_none_and_notes_nothing() {
        let boot = empty_boot();
        let harness = harness(&boot, PathBuf::from("/work"));
        assert!(harness.goals.is_none());
        assert!(harness.todos.is_none());
        assert!(harness.team.is_none());
        assert!(boot_notes(&boot).await.is_empty());
    }

    #[test]
    fn the_server_default_endpoint_falls_back_to_the_first() {
        let mut endpoints = heddle_config::default_endpoints();
        let mut second = endpoints[0].clone();
        second.name = "second".into();
        endpoints.push(second);
        let service = Arc::new(heddle_llm::ModelService::new(endpoints).unwrap());
        let models = Models {
            service: Arc::clone(&service),
        };
        // Nothing nominated: the first endpoint, not none.
        assert_eq!(models.default_endpoint().as_deref(), Some("scripted"));
        // A nominated default that exists wins.
        service.nominate_default("second");
        assert_eq!(models.default_endpoint().as_deref(), Some("second"));
    }

    #[test]
    fn the_plugin_inventory_lists_each_row_with_the_state_the_loader_left_it_in() {
        use crate::builtins::ComponentRef;
        let composed = |id: &str, name: &str, disabled: bool| heddle_config::ComposedRow {
            row: heddle_config::EntryRow {
                id: Some(id.to_owned()),
                name: name.to_owned(),
                disabled: disabled.then_some(true),
                ..heddle_config::EntryRow::default()
            },
            position: 0,
            fields: Vec::new(),
        };
        let entry = |id: &str, name: &str, state: FiberState| crate::boot::Entry {
            id: id.to_owned(),
            name: name.to_owned(),
            component: ComponentRef::Unresolved(name.to_owned()),
            requires: Vec::new(),
            state,
            error: None,
        };
        let mut boot = empty_boot();
        boot.rows = vec![
            composed("session", "./src/plugins/session.ts", false),
            composed("goal-tool", "./src/plugins/goal-tool.ts", true),
            composed("todo-tool", "./src/plugins/todo-tool.ts", false),
            composed("gone", "./gone.ts", false),
        ];
        boot.entries = vec![
            entry("session", "./src/plugins/session.ts", FiberState::Active),
            entry(
                "todo-tool",
                "./src/plugins/todo-tool.ts",
                FiberState::Failed,
            ),
            entry("gone", "./gone.ts", FiberState::Disposed),
        ];
        assert_eq!(
            serde_json::to_value(plugin_inventory_of(&boot)).unwrap(),
            json!({"entries": [
                {"entryId": "session", "moduleName": "./src/plugins/session.ts", "enabled": true, "fiberPhase": "active"},
                {"entryId": "goal-tool", "moduleName": "./src/plugins/goal-tool.ts", "enabled": false, "fiberPhase": null},
                {"entryId": "todo-tool", "moduleName": "./src/plugins/todo-tool.ts", "enabled": true, "fiberPhase": "failed"},
                {"entryId": "gone", "moduleName": "./gone.ts", "enabled": true, "fiberPhase": null},
            ]}),
            "the disabled row the loader gave no entry is listed disabled, and a disposed entry has no phase"
        );
        assert_eq!(
            fiber_phase(FiberState::Pending),
            Some(heddle_config::PluginFiberPhase::Pending)
        );
        assert_eq!(
            fiber_phase(FiberState::Loading),
            Some(heddle_config::PluginFiberPhase::Loading)
        );
        assert_eq!(
            fiber_phase(FiberState::Unloading),
            Some(heddle_config::PluginFiberPhase::Unloading)
        );
    }

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
