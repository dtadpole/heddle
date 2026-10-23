//! One adapter per built-in: the composition root's half of each crate.
//!
//! The binary does not re-implement a plugin. For each built-in it reads the row's `config` into the
//! owning crate's typed config, takes whatever the module injects from [`Services`], constructs the
//! crate's service, and registers it twice under the service name: the crate's own handle, which
//! another built-in's adapter takes to construct itself, and the narrow [`ports`](crate::ports) view
//! the commands read.
//!
//! An adapter is built by [`BuiltinCatalog`](crate::builtins::BuiltinCatalog) with the run's [`Env`],
//! because a row's configuration may name an environment reference and the machine's own endpoint file
//! lives outside the checkout. Each one lands as its crate's API does; the catalog returns `None` for a
//! built-in whose adapter is not written yet, which leaves that row failed rather than silently absent.

use std::path::PathBuf;
use std::sync::Arc;

use heddle_config::{
    EndpointPatch, Env, heddle_home, local_config_candidates, read_local_config, resolve_endpoints,
};
use heddle_sandbox::{
    ApprovalService, ApprovalsConfig, SandboxConfig, SandboxHost, SandboxService,
};
use serde::Deserialize;
use serde_json::Value;

use crate::builtins::Component;
use crate::ports::{
    AssembleOptions, ContextPort, CreateAt, GoalPort, ModelPort, OpenAt, PortError, PortResult,
    Record, SandboxPort, SessionDefinition, SessionHandle, SessionPort, ToolsPort, TreeRoot,
    WorkspacePort,
};
use crate::services::Services;

/// `src/plugins/model.ts`: one model service over the endpoints the layers and the machine declare.
pub struct ModelComponent {
    env: Env,
}

impl ModelComponent {
    /// The adapter for a run whose environment is this one.
    pub fn new(env: Env) -> Self {
        Self { env }
    }
}

/// The model row's config, as `plugins/model.ts` declares it: endpoints, the nominated default, and
/// whether the machine's own file is read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ModelConfig {
    endpoints: Vec<EndpointPatch>,
    default: Option<String>,
    read_local_config: bool,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            endpoints: Vec::new(),
            default: None,
            // `readLocalConfig` defaults to true: the machine's file is where a real endpoint lives.
            read_local_config: true,
        }
    }
}

/// The model row's schema, the subset of `plugins/model.ts`'s Schemastery that `--validate` can check
/// without starting anything.
fn model_schema() -> Option<heddle_config::Schema> {
    heddle_config::Schema::from_json(serde_json::json!({
        "type": "object",
        "properties": {
            "endpoints": { "type": "array" },
            "default": { "type": "string" },
            "readLocalConfig": { "type": "boolean" },
        },
    }))
    .ok()
}

impl Component for ModelComponent {
    fn requires(&self) -> Vec<String> {
        // `plugins/model.ts` injects nothing.
        Vec::new()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        model_schema()
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: ModelConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("model: {error}"))?;
        let mut local_endpoints = Vec::new();
        let mut excluded = Vec::new();
        if config.read_local_config {
            let candidates = local_config_candidates(&self.env);
            match read_local_config(&candidates) {
                Ok(Some(location)) => {
                    local_endpoints = location
                        .config
                        .endpoint_patches(&location.path)
                        .map_err(|error| error.to_string())?;
                    excluded = location.config.exclude.clone().unwrap_or_default();
                }
                Ok(None) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        // The layering rule is the configuration crate's: defaults, then the layers, then the machine's
        // file, with the environment's overrides and the exclusions applied last.
        let endpoints =
            resolve_endpoints(&config.endpoints, &local_endpoints, &self.env, &excluded)
                .map_err(|error| error.to_string())?;
        let service =
            heddle_llm::ModelService::from_configuration(endpoints, config.default.as_deref())
                .map_err(|error| error.to_string())?;
        let service = Arc::new(service);
        // `model/request` reaches the bus, where a hook may rewrite the request.
        if let Some(hooks) = bus_hooks(services) {
            service.add_hooks(Arc::new(hooks));
        }
        services.provide("model", Arc::clone(&service));
        services.provide(
            "model",
            Arc::new(ModelView {
                service: Arc::clone(&service),
            }) as Arc<dyn ModelPort>,
        );
        Ok(())
    }
}

/// `ctx.model` over `heddle-llm`'s service: the commands' narrow view.
struct ModelView {
    service: Arc<heddle_llm::ModelService>,
}

impl ModelPort for ModelView {
    fn describe(&self) -> Vec<Record> {
        self.service
            .list()
            .iter()
            .map(heddle_config::describe_endpoint)
            .collect()
    }

    fn names(&self) -> Vec<String> {
        self.service.names()
    }

    fn default_endpoint(&self) -> Option<String> {
        self.service.default_endpoint(None)
    }
}

/// `src/sandbox/service.ts`: the fence every file and shell effect passes through.
pub struct SandboxComponent {
    env: Env,
    cwd: PathBuf,
}

impl SandboxComponent {
    /// The adapter for a run started in `cwd`, whose harness home is `env`'s.
    pub fn new(env: Env, cwd: PathBuf) -> Self {
        Self { env, cwd }
    }
}

/// The sandbox row's schema: the words and paths `--validate` can check without starting a backend.
fn sandbox_schema() -> Option<heddle_config::Schema> {
    heddle_config::Schema::from_json(serde_json::json!({
        "type": "object",
        "properties": {
            "mode": { "type": "string" },
            "workspaceRoot": { "type": "string" },
            "extraWritableRoots": { "type": "array" },
            "backend": { "type": "string" },
            "landlockRunner": { "type": "string" },
        },
    }))
    .ok()
}

impl Component for SandboxComponent {
    fn requires(&self) -> Vec<String> {
        // The sandbox plugin injects nothing; it is the fence the others ask.
        Vec::new()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        sandbox_schema()
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        // A mode outside the vocabulary is a deserialisation error on purpose: papering over it would
        // turn the fail-closed profile into a silently permissive one.
        let config: SandboxConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("sandbox: {error}"))?;
        let host = SandboxHost {
            cwd: self.cwd.clone(),
            harness_home: heddle_home(&self.env),
            platform: heddle_sandbox::Platform::current(),
        };
        let service = Arc::new(SandboxService::new(&config, &host));
        services.provide("sandbox", Arc::clone(&service));
        services.provide(
            "sandbox",
            Arc::new(SandboxView {
                service: Arc::clone(&service),
            }) as Arc<dyn SandboxPort>,
        );
        Ok(())
    }
}

/// `ctx.sandbox` over the crate's service: the commands' narrow view.
struct SandboxView {
    service: Arc<SandboxService>,
}

impl SandboxPort for SandboxView {
    fn workspace_root(&self) -> PathBuf {
        self.service.workspace_root().to_path_buf()
    }
}

/// `src/approvals/service.ts`: the standing policy and the question channel.
pub struct ApprovalsComponent;

/// The approvals row's schema.
fn approvals_schema() -> Option<heddle_config::Schema> {
    heddle_config::Schema::from_json(serde_json::json!({
        "type": "object",
        "properties": {
            "mode": { "type": "string" },
            "deny": { "type": "array" },
            "allow": { "type": "array" },
            "unanswered": { "type": "string" },
            "answerTimeoutMs": { "type": "number" },
        },
    }))
    .ok()
}

impl Component for ApprovalsComponent {
    fn requires(&self) -> Vec<String> {
        Vec::new()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        approvals_schema()
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: ApprovalsConfig = serde_json::from_value(config.clone())
            .map_err(|error| format!("approvals: {error}"))?;
        services.provide("approvals", Arc::new(ApprovalService::new(config)));
        Ok(())
    }
}

/// `src/plugins/session.ts`: the session store and its service.
pub struct SessionComponent {
    env: Env,
}

impl SessionComponent {
    /// The adapter for a run whose environment is this one.
    pub fn new(env: Env) -> Self {
        Self { env }
    }
}

fn session_schema() -> Option<heddle_config::Schema> {
    heddle_config::Schema::from_json(serde_json::json!({
        "type": "object",
        "properties": { "root": { "type": "string" } },
    }))
    .ok()
}

impl Component for SessionComponent {
    fn requires(&self) -> Vec<String> {
        Vec::new()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        session_schema()
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: heddle_session::SessionConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("session: {error}"))?;
        // Every appended event is emitted as `session/event` on the bus, as the TypeScript store does, and
        // published on the server's hub, so a page that is open sees it as it lands.
        let bus = services.get::<heddle_events::EventBus>("events");
        let hub = services
            .get::<heddle_server::EventHub>("event-hub")
            .map(heddle_server::adapters::session_event_listener);
        let listener = (bus.is_some() || hub.is_some()).then(|| {
            Arc::new(
                move |handle: &heddle_session::SessionHandle,
                      event: &heddle_session::SessionEvent| {
                    if let Some(bus) = &bus {
                        heddle_events::bridge::session_event(bus, &handle.id, &event.to_value());
                    }
                    if let Some(hub) = &hub {
                        hub(handle, event);
                    }
                },
            ) as heddle_session::EventListener
        });
        let service = Arc::new(heddle_session::SessionService::new(
            &config, &self.env, listener,
        ));
        services.provide("session", Arc::clone(&service));
        services.provide(
            "session",
            Arc::new(SessionView {
                service: Arc::clone(&service),
            }) as Arc<dyn SessionPort>,
        );
        Ok(())
    }
}

/// A session handle as the commands pass it, over the crate's own handle.
fn handle_of(handle: heddle_session::SessionHandle) -> SessionHandle {
    SessionHandle {
        id: handle.id.to_string(),
        transcript: PathBuf::from(&handle.transcript),
        inner: Arc::new(handle),
    }
}

/// The crate's own handle back out of one the commands passed.
fn inner_of(handle: &SessionHandle) -> PortResult<&heddle_session::SessionHandle> {
    handle
        .inner
        .downcast_ref::<heddle_session::SessionHandle>()
        .ok_or_else(|| PortError::new("a session handle from another store"))
}

fn port_error(error: impl std::fmt::Display) -> PortError {
    PortError::new(error.to_string())
}

/// `ctx.session` over `heddle-session`'s service: the commands' narrow view.
struct SessionView {
    service: Arc<heddle_session::SessionService>,
}

impl SessionPort for SessionView {
    fn root(&self) -> PathBuf {
        PathBuf::from(self.service.store().root())
    }

    fn list(&self) -> Vec<Record> {
        self.service
            .list()
            .iter()
            .map(|meta| meta.to_value())
            .collect()
    }

    fn open(&self, id: &str) -> Option<SessionHandle> {
        self.service.open(id).map(handle_of)
    }

    fn resume(&self, id: &str) -> PortResult<SessionHandle> {
        self.service
            .start(heddle_session::StartOptions {
                resume: Some(id.to_owned()),
                ..heddle_session::StartOptions::default()
            })
            .map(handle_of)
            .map_err(port_error)
    }

    fn current(&self, cwd: &std::path::Path) -> PortResult<SessionHandle> {
        self.service
            .start(heddle_session::StartOptions {
                cwd: Some(cwd.to_string_lossy().into_owned()),
                ..heddle_session::StartOptions::default()
            })
            .map(handle_of)
            .map_err(port_error)
    }

    fn open_at(&self, folder: &std::path::Path, options: OpenAt) -> PortResult<SessionHandle> {
        self.service
            .open_at(
                &folder.to_string_lossy(),
                heddle_session::OpenAtOptions {
                    fresh: options.fresh,
                    endpoint: Some(options.endpoint),
                    model: options.model,
                    reasoning_effort: None,
                    title: Some(options.title),
                },
            )
            .map(handle_of)
            .map_err(port_error)
    }

    fn create_at(
        &self,
        branch: &std::path::Path,
        options: CreateAt,
    ) -> PortResult<(SessionHandle, SessionDefinition)> {
        let created = self
            .service
            .create_at(
                &branch.to_string_lossy(),
                heddle_session::CreateAtOptions {
                    title: options.title,
                    endpoint: options.endpoint,
                    model: options.model,
                    reasoning_effort: None,
                },
            )
            .map_err(port_error)?;
        let definition = SessionDefinition {
            name: created.definition.name.clone(),
            dir: PathBuf::from(&created.definition.dir),
            file: PathBuf::from(&created.definition.file),
            log: PathBuf::from(&created.definition.log),
        };
        Ok((handle_of(created.handle), definition))
    }

    fn events(&self, handle: &SessionHandle) -> PortResult<Vec<Record>> {
        let events = self.service.events(inner_of(handle)?).map_err(port_error)?;
        Ok(events.iter().map(|event| event.to_value()).collect())
    }

    fn folder(&self, handle: &SessionHandle) -> Option<PathBuf> {
        inner_of(handle)
            .ok()
            .and_then(|inner| self.service.folder(inner))
            .map(PathBuf::from)
    }

    fn tree(
        &self,
        wanted: Option<&std::path::Path>,
        roots: &[TreeRoot],
        _sessions: &[Record],
        generated: &[String],
    ) -> PortResult<Record> {
        let roots = roots
            .iter()
            .map(|root| heddle_workspace::TreeRoot {
                path: root.path.to_string_lossy().into_owned(),
                title: root.title.clone(),
                origin: root
                    .origin
                    .as_ref()
                    .and_then(|origin| serde_json::from_value(Value::String(origin.clone())).ok()),
            })
            .collect();
        let input = heddle_workspace::TreeInput {
            roots,
            // The crate's own metadata, not the records the command printed: the tree reads fields
            // (the folder binding, the archive flag) the commands never name.
            sessions: self.service.list(),
            generated: generated.to_vec(),
            archived: heddle_workspace::ArchivedFilter::default(),
        };
        let wanted = wanted.map(|path| path.to_string_lossy().into_owned());
        serde_json::to_value(heddle_workspace::tree(wanted.as_deref(), &input)).map_err(port_error)
    }

    fn read_file_text(&self, path: &std::path::Path) -> PortResult<Record> {
        let reading =
            heddle_workspace::read_file_text(&path.to_string_lossy(), None).map_err(port_error)?;
        serde_json::to_value(reading).map_err(port_error)
    }
}

/// `src/workspace/service.ts`: the registered roots.
pub struct WorkspaceComponent {
    env: Env,
}

impl WorkspaceComponent {
    /// The adapter for a run whose environment is this one.
    pub fn new(env: Env) -> Self {
        Self { env }
    }
}

fn workspace_schema() -> Option<heddle_config::Schema> {
    heddle_config::Schema::from_json(serde_json::json!({
        "type": "object",
        "properties": {
            "file": { "type": "string" },
            "generated": { "type": "array", "items": { "type": "string" } },
        },
    }))
    .ok()
}

impl Component for WorkspaceComponent {
    fn requires(&self) -> Vec<String> {
        // `src/workspace/service.ts` injects the session service.
        vec!["session".to_owned()]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        workspace_schema()
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: heddle_workspace::WorkspaceConfig = serde_json::from_value(config.clone())
            .map_err(|error| format!("workspace: {error}"))?;
        let service = Arc::new(heddle_workspace::WorkspaceService::new(&config, &self.env));
        // Every load reconciles the roots with the sessions already recorded, adopting each folder a
        // session ran in as an `auto` root: src/workspace/service.ts runs `bootstrap` in its constructor.
        let sessions = session_service(services, "workspace")?;
        service
            .bootstrap(&sessions.list())
            .map_err(|error| format!("workspace: {error}"))?;
        services.provide("workspace", Arc::clone(&service));
        services.provide(
            "workspace",
            Arc::new(WorkspaceView { service }) as Arc<dyn WorkspacePort>,
        );
        Ok(())
    }
}

/// `ctx.workspace` over `heddle-workspace`'s service.
struct WorkspaceView {
    service: Arc<heddle_workspace::WorkspaceService>,
}

impl WorkspaceView {
    /// The crate's own metadata for the records a command passed, by id.
    fn metas(&self, all: &[Record]) -> Vec<heddle_session::SessionMeta> {
        all.iter()
            .filter_map(|record| heddle_session::SessionMeta::from_value(record.clone()))
            .collect()
    }

    fn record(&self, record: &Record) -> Option<heddle_workspace::WorkspaceRecord> {
        serde_json::from_value(record.clone()).ok()
    }
}

impl WorkspacePort for WorkspaceView {
    fn file(&self) -> PathBuf {
        PathBuf::from(self.service.file())
    }

    fn list(&self) -> Vec<Record> {
        self.service
            .list()
            .iter()
            .filter_map(|record| serde_json::to_value(record).ok())
            .collect()
    }

    fn sessions(&self, record: &Record, all: &[Record]) -> Vec<Record> {
        let Some(record) = self.record(record) else {
            return Vec::new();
        };
        self.service
            .sessions(&record, &self.metas(all))
            .iter()
            .map(|meta| meta.to_value())
            .collect()
    }

    fn add(&self, path: &str, name: Option<&str>) -> PortResult<(Record, bool)> {
        let added = self.service.add(path, name).map_err(port_error)?;
        Ok((
            serde_json::to_value(&added.record).map_err(port_error)?,
            added.created,
        ))
    }

    fn rename(&self, target: &str, name: &str) -> PortResult<Option<Record>> {
        let renamed = self.service.rename(target, name).map_err(port_error)?;
        renamed
            .map(|record| serde_json::to_value(record).map_err(port_error))
            .transpose()
    }

    fn remove(&self, target: &str, all: &[Record], force: bool) -> PortResult<Record> {
        let removal = self
            .service
            .remove(target, &self.metas(all), force)
            .map_err(port_error)?;
        serde_json::to_value(removal).map_err(port_error)
    }

    fn owner(&self, path: &std::path::Path) -> Option<Record> {
        self.service
            .owner(&path.to_string_lossy())
            .and_then(|record| serde_json::to_value(record).ok())
    }

    fn ensure_owner(&self, path: &std::path::Path) -> PortResult<()> {
        self.service
            .ensure_owner(&path.to_string_lossy())
            .map(|_| ())
            .map_err(port_error)
    }

    fn generated(&self) -> Vec<String> {
        self.service.generated().to_vec()
    }
}

/// A component that provides at most one plain service and needs nothing: the binary's own built-ins.
///
/// `console-exporter` sends plugin log lines to the terminal, which the binary's two streams already do,
/// so it provides nothing; `greeting` provides the greeting service; `announce` waits for it. Their
/// `heddle/ready` behaviour belongs to the bare application (port plan step 4).
pub struct InCrateComponent {
    provides: Option<&'static str>,
    requires: &'static [&'static str],
}

impl InCrateComponent {
    /// `src/plugins/console-exporter.ts`.
    pub fn console() -> Self {
        Self {
            provides: None,
            requires: &[],
        }
    }

    /// `src/plugins/greeting.ts`.
    pub fn greeting() -> Self {
        Self {
            provides: Some("greeting"),
            requires: &[],
        }
    }

    /// `src/plugins/announce.ts`.
    pub fn announce() -> Self {
        Self {
            provides: None,
            requires: &["greeting"],
        }
    }
}

/// The greeting service: `greet(who)` is `hello, <who><punctuation>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Greeting {
    punctuation: String,
}

impl Greeting {
    /// Build the greeting this service exists to produce.
    pub fn greet(&self, who: &str) -> String {
        format!("hello, {who}{}", self.punctuation)
    }
}

impl Component for InCrateComponent {
    fn requires(&self) -> Vec<String> {
        self.requires
            .iter()
            .map(|name| (*name).to_owned())
            .collect()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        if self.provides == Some("greeting") {
            let punctuation = config
                .get("punctuation")
                .and_then(Value::as_str)
                .unwrap_or("!")
                .to_owned();
            services.provide("greeting", Arc::new(Greeting { punctuation }));
        }
        Ok(())
    }
}

/// `heddle-session`'s store as the event log `heddle-goal` and `heddle-todo` fold their state from.
#[derive(Clone)]
pub struct StoreLog {
    sessions: Arc<heddle_session::SessionService>,
}

impl StoreLog {
    fn open(&self, id: &str) -> Option<String> {
        self.sessions.open(id).map(|handle| handle.id.to_string())
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, String> {
        let handle = self
            .sessions
            .open(session)
            .ok_or_else(|| format!("no session '{session}'"))?;
        let events = self
            .sessions
            .events(&handle)
            .map_err(|error| error.to_string())?;
        Ok(events.iter().map(|event| event.to_value()).collect())
    }

    fn append(
        &self,
        session: &str,
        mut event: serde_json::Map<String, Value>,
    ) -> Result<Value, String> {
        let handle = self
            .sessions
            .open(session)
            .ok_or_else(|| format!("no session '{session}'"))?;
        let kind = match event.remove("type") {
            Some(Value::String(kind)) => kind,
            _ => return Err("an event needs a string type".to_owned()),
        };
        let written = self
            .sessions
            .store()
            .append(
                &handle,
                heddle_session::NewEvent {
                    kind,
                    fields: event,
                },
                heddle_session::AppendOptions::default(),
            )
            .map_err(|error| error.to_string())?;
        Ok(written.to_value())
    }
}

impl heddle_todo::SessionLog for StoreLog {
    fn open(&self, id: &str) -> Option<String> {
        StoreLog::open(self, id)
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, heddle_todo::LogError> {
        StoreLog::read(self, session).map_err(heddle_todo::LogError)
    }

    fn append(
        &self,
        session: &str,
        event: serde_json::Map<String, Value>,
    ) -> Result<Value, heddle_todo::LogError> {
        StoreLog::append(self, session, event).map_err(heddle_todo::LogError)
    }
}

impl heddle_goal::SessionLog for StoreLog {
    fn open(&self, id: &str) -> Option<String> {
        StoreLog::open(self, id)
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, heddle_goal::LogError> {
        StoreLog::read(self, session).map_err(heddle_goal::LogError)
    }

    fn append(
        &self,
        session: &str,
        event: serde_json::Map<String, Value>,
    ) -> Result<Value, heddle_goal::LogError> {
        StoreLog::append(self, session, event).map_err(heddle_goal::LogError)
    }
}

/// The session service a row injects, or the sentence naming it.
fn session_service(
    services: &Services,
    row: &str,
) -> Result<Arc<heddle_session::SessionService>, String> {
    services
        .get::<Arc<heddle_session::SessionService>>("session")
        .ok_or_else(|| format!("{row}: the session service is not provided"))
}

/// `src/plugins/tools.ts`: the tool registry, gated by the deployment's sandbox and approvals.
pub struct ToolsComponent;

impl Component for ToolsComponent {
    fn requires(&self) -> Vec<String> {
        vec![
            "approvals".to_owned(),
            "sandbox".to_owned(),
            "session".to_owned(),
        ]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        heddle_config::Schema::from_json(serde_json::json!({
            "type": "object",
            "properties": {
                "allow": { "type": "array", "items": { "type": "string" } },
                "includeBuiltins": { "type": "boolean" },
                "bashTimeoutMs": { "type": "number" },
            },
        }))
        .ok()
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config = heddle_tools::ToolsConfig::from_row(config)
            .map_err(|error| format!("tools: {error}"))?;
        let approvals = services
            .get::<Arc<heddle_sandbox::ApprovalService>>("approvals")
            .ok_or_else(|| "tools: the approvals service is not provided".to_owned())?;
        let sandbox = services
            .get::<Arc<heddle_sandbox::SandboxService>>("sandbox")
            .ok_or_else(|| "tools: the sandbox service is not provided".to_owned())?;
        let sessions = session_service(services, "tools")?;
        // The sandbox, the approval policy and each session's recorded mode, as heddle-tools composes them.
        let mut gates = heddle_tools::adapters::gates_over(sandbox, approvals, sessions);
        // `tools/pre-execute` and `tools/post-execute` reach the bus.
        if let Some(hooks) = bus_hooks(services) {
            gates.hooks = Arc::new(hooks);
        }
        let registry = Arc::new(heddle_tools::ToolRegistry::from_config(gates, &config));
        services.provide("tools", Arc::clone(&registry));
        services.provide(
            "tools",
            Arc::new(ToolsView { registry }) as Arc<dyn ToolsPort>,
        );
        Ok(())
    }
}

/// `ctx.tools` over the registry.
struct ToolsView {
    registry: Arc<heddle_tools::ToolRegistry>,
}

impl ToolsPort for ToolsView {
    fn describe(&self) -> Vec<Record> {
        self.registry
            .describe()
            .iter()
            .filter_map(|spec| serde_json::to_value(spec).ok())
            .collect()
    }

    fn describe_commands(&self) -> Vec<Record> {
        self.registry
            .describe_commands()
            .iter()
            .filter_map(|summary| serde_json::to_value(summary).ok())
            .collect()
    }

    fn allow_list(&self) -> Vec<String> {
        self.registry.allow_list().to_vec()
    }

    fn filter_to(&self, allow: &[String]) {
        self.registry.filter_to(allow);
    }

    fn missing(&self) -> Vec<String> {
        self.registry.missing()
    }
}

/// A tool another crate defines as a spec and a run function, registered with the tool registry.
fn register_answering<F>(
    registry: &heddle_tools::ToolRegistry,
    spec: Value,
    run: F,
) -> Result<(), String>
where
    F: Fn(Option<&str>, &Value) -> Value + Send + Sync + 'static,
{
    let spec: heddle_tools::ToolSpec =
        serde_json::from_value(spec).map_err(|error| format!("a tool spec: {error}"))?;
    let run = Arc::new(run);
    let tool = heddle_tools::tool_fn(spec, move |args, context| {
        let run = Arc::clone(&run);
        Box::pin(async move {
            let session = context
                .context()
                .session
                .as_ref()
                .map(|handle| handle.id.clone());
            let answer = run(session.as_deref(), &Value::Object(args));
            // The crates' answers are the TypeScript `ToolResult`: output, error?, data?.
            Ok(
                serde_json::from_value::<heddle_tools::ToolResult>(answer).unwrap_or_else(
                    |error| heddle_tools::ToolResult {
                        output: String::new(),
                        error: Some(heddle_tools::ToolError {
                            code: "TOOL_ERROR".to_owned(),
                            message: format!("the tool's answer could not be read: {error}"),
                        }),
                        data: None,
                    },
                ),
            )
        })
    });
    registry.register(tool).map_err(|error| error.to_string())
}

/// `src/todo/service.ts`: a session's todo list, folded from its log.
pub struct TodoComponent;

impl Component for TodoComponent {
    fn requires(&self) -> Vec<String> {
        vec!["session".to_owned()]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: heddle_todo::TodoConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("todo: {error}"))?;
        let log = StoreLog {
            sessions: session_service(services, "todo")?,
        };
        services.provide(
            "todo",
            Arc::new(heddle_todo::TodoService::new(Arc::new(log), config)),
        );
        Ok(())
    }
}

/// `src/plugins/todo-tool.ts`: `todo_write` and `todo_read` in the registry.
pub struct TodoToolComponent;

impl Component for TodoToolComponent {
    fn requires(&self) -> Vec<String> {
        vec!["todo".to_owned(), "tools".to_owned()]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, _config: &Value, services: &mut Services) -> Result<(), String> {
        let todo = services
            .get::<Arc<heddle_todo::TodoService>>("todo")
            .ok_or_else(|| "todo-tool: the todo service is not provided".to_owned())?;
        let registry = services
            .get::<Arc<heddle_tools::ToolRegistry>>("tools")
            .ok_or_else(|| "todo-tool: the tool registry is not provided".to_owned())?;
        for spec in heddle_todo::tool::todo_tool_specs() {
            let name = spec.name.clone();
            let todo = Arc::clone(&todo);
            let spec = serde_json::to_value(&spec).map_err(|error| error.to_string())?;
            register_answering(&registry, spec, move |session, args| {
                let answer = if name == "todo_read" {
                    heddle_todo::tool::run_todo_read(&todo, session)
                } else {
                    heddle_todo::tool::run_todo_write(&todo, session, args)
                };
                serde_json::to_value(answer).unwrap_or(Value::Null)
            })?;
        }
        Ok(())
    }
}

/// `src/goal/service.ts`: the goal a session works toward, folded from its log.
pub struct GoalComponent;

impl Component for GoalComponent {
    fn requires(&self) -> Vec<String> {
        vec!["session".to_owned()]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: heddle_goal::GoalConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("goal: {error}"))?;
        let log = StoreLog {
            sessions: session_service(services, "goal")?,
        };
        let service = Arc::new(heddle_goal::GoalService::new(Arc::new(log), config));
        services.provide("goal", Arc::clone(&service));
        services.provide("goal", Arc::new(GoalView { service }) as Arc<dyn GoalPort>);
        Ok(())
    }
}

/// `ctx.goal` over the goal service.
struct GoalView {
    service: Arc<heddle_goal::GoalService>,
}

impl GoalPort for GoalView {
    fn get(&self, handle: &SessionHandle) -> PortResult<Option<Record>> {
        let view = self.service.get(&handle.id).map_err(port_error)?;
        view.map(|view| serde_json::to_value(view).map_err(port_error))
            .transpose()
    }
}

/// `src/plugins/goal-tool.ts`: `create_goal`, `get_goal` and `update_goal` in the registry.
pub struct GoalToolComponent;

impl Component for GoalToolComponent {
    fn requires(&self) -> Vec<String> {
        vec!["goal".to_owned(), "tools".to_owned()]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, _config: &Value, services: &mut Services) -> Result<(), String> {
        let goals = services
            .get::<Arc<heddle_goal::GoalService>>("goal")
            .ok_or_else(|| "goal-tool: the goal service is not provided".to_owned())?;
        let registry = services
            .get::<Arc<heddle_tools::ToolRegistry>>("tools")
            .ok_or_else(|| "goal-tool: the tool registry is not provided".to_owned())?;
        for spec in heddle_goal::tool::goal_tool_specs() {
            let name = spec.name.clone();
            let goals = Arc::clone(&goals);
            let spec = serde_json::to_value(&spec).map_err(|error| error.to_string())?;
            register_answering(&registry, spec, move |session, args| {
                let answer = match name.as_str() {
                    "create_goal" => heddle_goal::tool::run_create_goal(&goals, session, args),
                    "update_goal" => heddle_goal::tool::run_update_goal(&goals, session, args),
                    _ => heddle_goal::tool::run_get_goal(&goals, session),
                };
                serde_json::to_value(answer).unwrap_or(Value::Null)
            })?;
        }
        Ok(())
    }
}

/// `src/plugins/turns.ts`: the live-turn registry, which the server's stop and a team's abort ask.
pub struct TurnsComponent;

impl Component for TurnsComponent {
    fn requires(&self) -> Vec<String> {
        Vec::new()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, _config: &Value, services: &mut Services) -> Result<(), String> {
        services.provide("turns", heddle_agent::TurnRegistry::new());
        Ok(())
    }
}

/// One shape to another through their shared serialization: the crates each declare the TypeScript
/// message and request types, so a value crosses a crate boundary by its JSON.
fn bridge<T: serde::Serialize, U: serde::de::DeserializeOwned>(value: &T) -> Result<U, String> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|error| error.to_string())
}

/// `heddle-llm`'s service as what `heddle-context` asks of the model layer: an endpoint's window and a
/// summary call.
struct ContextModels {
    service: Arc<heddle_llm::ModelService>,
}

impl heddle_context::ModelAccess for ContextModels {
    fn endpoint_window(&self, endpoint: &str, model: Option<&str>) -> Option<u64> {
        self.service.endpoint(endpoint)?.context_window_for(model)
    }

    fn complete(
        &self,
        request: heddle_context::SummaryRequest,
    ) -> futures::future::BoxFuture<'_, Result<String, heddle_context::SummarizeError>> {
        Box::pin(async move {
            let messages = bridge(&request.messages).map_err(|error| {
                heddle_context::SummarizeError(format!("the summary request: {error}"))
            })?;
            let generated = self
                .service
                .generate(heddle_llm::GenerateRequest {
                    endpoint: request.endpoint,
                    model: request.model,
                    messages,
                    max_output_tokens: request.max_output_tokens,
                    purpose: request.purpose,
                    ..heddle_llm::GenerateRequest::default()
                })
                .await
                .map_err(|error| heddle_context::SummarizeError(error.to_string()))?;
            Ok(generated.text)
        })
    }
}

/// The context service the binary composes: over the session store (heddle-context binds its store
/// trait to heddle-session's store itself), with the model layer.
pub type Context = heddle_context::ContextService<heddle_session::SessionStore>;

/// `src/context/service.ts`: context assembly, the budget and compaction.
pub struct ContextComponent {
    env: Env,
}

impl ContextComponent {
    /// The adapter for a run whose environment is this one.
    pub fn new(env: Env) -> Self {
        Self { env }
    }
}

impl Component for ContextComponent {
    fn requires(&self) -> Vec<String> {
        // `src/context/service.ts` injects the model and the session.
        vec!["model".to_owned(), "session".to_owned()]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: heddle_context::ContextConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("context: {error}"))?;
        let sessions = session_service(services, "context")?;
        let models = services
            .get::<Arc<heddle_llm::ModelService>>("model")
            .ok_or_else(|| "context: the model service is not provided".to_owned())?;
        let service = Arc::new(heddle_context::ContextService::new(
            Arc::clone(sessions.store()),
            config,
            heddle_context::ContextDependencies {
                model: Some(Arc::new(ContextModels { service: models })),
                heddle_home: heddle_home(&self.env),
            },
        ));
        services.provide("context", Arc::clone(&service));
        services.provide(
            "context",
            Arc::new(ContextView { service }) as Arc<dyn ContextPort>,
        );
        Ok(())
    }
}

/// `ctx.context` over the context service: the report the `context` command prints.
struct ContextView {
    service: Arc<Context>,
}

impl ContextPort for ContextView {
    fn assemble(&self, handle: &SessionHandle, options: AssembleOptions) -> PortResult<Record> {
        let inner = inner_of(handle)?;
        let tools: Vec<heddle_context::ToolSpec> = options
            .tools
            .iter()
            .filter_map(|tool| serde_json::from_value(tool.clone()).ok())
            .collect();
        let cwd = options.cwd.unwrap_or_else(|| PathBuf::from("."));
        let report = self
            .service
            .assemble(
                inner,
                &heddle_context::AssembleOptions {
                    cwd: &cwd,
                    tools: &tools,
                    system: None,
                    endpoint: options.endpoint.as_deref(),
                    model: options.model.as_deref(),
                },
            )
            .map_err(port_error)?;
        // The view is the TypeScript `context --json` object; its messages are already described as
        // `{ role, toolCallId?, text }`, which is what the command prints.
        serde_json::to_value(report.view(&handle.id)).map_err(port_error)
    }
}

/// An outside component: a process a row declares by a manifest (`program`, `args`, `config` schema),
/// spoken to as line-delimited JSON-RPC on stdio (part 4). heddle-tools starts it and turns the tools it
/// declares in `initialize` into registry tools, gated like every other tool.
pub struct OutsideRow {
    manifest: PathBuf,
}

impl OutsideRow {
    /// The component a row's manifest at `manifest` declares.
    pub fn new(manifest: PathBuf) -> Self {
        Self { manifest }
    }

    /// The process the manifest names: a `.`-relative program resolves against the manifest's folder,
    /// any other name is looked up as the system would.
    fn spec(&self, config: &Value) -> Result<heddle_tools::OutsideComponentSpec, String> {
        let manifest = heddle_config::read_component_manifest(&self.manifest)
            .map_err(|error| error.to_string())?;
        let folder = self
            .manifest
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let program = if manifest.program.starts_with('.') {
            heddle_config::paths::resolve(&folder, std::path::Path::new(&manifest.program))
        } else {
            PathBuf::from(&manifest.program)
        };
        let row = self
            .manifest
            .file_name()
            .map(|name| {
                name.to_string_lossy()
                    .trim_end_matches(".component.yml")
                    .to_owned()
            })
            .unwrap_or_default();
        let mut spec = heddle_tools::OutsideComponentSpec::new(row, program, folder);
        spec.args = manifest.args;
        spec.config = config.clone();
        Ok(spec)
    }
}

impl Component for OutsideRow {
    fn requires(&self) -> Vec<String> {
        // It registers into the registry, and its calls are confined by the same sandbox.
        vec!["tools".to_owned(), "sandbox".to_owned()]
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        // `--validate` reads the manifest through heddle-config's catalog; the component adds nothing.
        None
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let spec = self.spec(config)?;
        let sandbox = services
            .get::<Arc<heddle_sandbox::SandboxService>>("sandbox")
            .ok_or_else(|| "the sandbox service is not provided".to_owned())?;
        let registry = services
            .get::<Arc<heddle_tools::ToolRegistry>>("tools")
            .ok_or_else(|| "the tool registry is not provided".to_owned())?;
        let _ = sandbox;
        // The registry's own gate, so the component's calls are confined exactly as the built-ins'.
        let gate = Arc::clone(registry.sandbox());
        let row = spec.row.clone();
        let component = Arc::new(
            crate::runtime::tokio()
                .block_on(heddle_tools::OutsideComponent::start(spec, gate))
                .map_err(|error| error.to_string())?,
        );
        component
            .register_into(&registry)
            .map_err(|error| error.to_string())?;
        // The listeners it declared in `initialize` attach to the bus under its own scope.
        let listeners = match services.get::<heddle_events::EventBus>("events") {
            Some(bus) => {
                let scope = bus.scope(row);
                let listeners = heddle_events::ports::attach_component_listeners(
                    &scope,
                    Arc::clone(&component),
                )
                .map_err(|error| error.to_string())?;
                Some((scope, listeners))
            }
            None => None,
        };
        // The process, its scope and its listeners live as long as the run.
        services.provide(
            &format!("outside:{}", self.manifest.display()),
            Arc::new((component, listeners)),
        );
        Ok(())
    }
}

/// The hook points over the run's bus, when the boot made one.
pub fn bus_hooks(services: &Services) -> Option<heddle_events::ports::BusHooks> {
    services
        .get::<heddle_events::EventBus>("events")
        .map(heddle_events::ports::BusHooks::new)
}

/// The services every agent row waits for: what the shared runtime is built from.
const AGENT_SERVICES: [&str; 4] = ["model", "session", "context", "tools"];

/// `src/plugins/subagent-tool.ts`: `delegate`, a child agent on the same runtime.
pub struct SubagentToolComponent;

impl Component for SubagentToolComponent {
    fn requires(&self) -> Vec<String> {
        AGENT_SERVICES
            .iter()
            .map(|name| (*name).to_owned())
            .collect()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: heddle_agent::SubagentConfig =
            if config.as_object().is_some_and(|map| map.is_empty()) {
                heddle_agent::SubagentConfig::default()
            } else {
                serde_json::from_value(config.clone())
                    .map_err(|error| format!("subagent-tool: {error}"))?
            };
        let sessions = session_service(services, "subagent-tool")?;
        let runtime = crate::runtime::shared_runtime(services)?;
        let deps = heddle_agent::SubagentDeps {
            store: Arc::new(heddle_agent::adapters::SessionSubagents::new(sessions)),
            run: heddle_agent::subagent_runner(Arc::downgrade(&runtime)),
        };
        for tool in heddle_agent::subagent_tools(deps, config.into()) {
            runtime
                .tools
                .register(tool)
                .map_err(|error| format!("subagent-tool: {error}"))?;
        }
        Ok(())
    }
}

/// `src/plugins/goal-driver.ts`: a goal continues itself, one round at a time, on the shared runtime.
pub struct GoalDriverComponent;

/// A goal round: a turn in the goal's session, on its recorded endpoint, its source naming the goal.
struct GoalRounds {
    runtime: std::sync::Weak<heddle_agent::AgentRuntime>,
    sessions: Arc<heddle_session::SessionService>,
}

impl heddle_goal::RoundRunner for GoalRounds {
    fn run(
        &self,
        session: &str,
        prompt: String,
        source: heddle_goal::GoalRoundSource,
    ) -> futures::future::BoxFuture<'static, Result<(), String>> {
        let runtime = self.runtime.clone();
        let sessions = Arc::clone(&self.sessions);
        let session = session.to_owned();
        Box::pin(async move {
            let runtime = runtime
                .upgrade()
                .ok_or("the run that owned this goal has ended")?;
            let handle = sessions
                .open(&session)
                .ok_or_else(|| format!("no session '{session}'"))?;
            let endpoint = sessions
                .meta(&session)
                .and_then(|meta| {
                    meta.as_map()
                        .get("endpoint")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .or_else(|| runtime.model.default_endpoint())
                .ok_or("no endpoint is configured")?;
            let mut options = heddle_agent::RunTurnOptions::new(handle, endpoint, prompt);
            options.source = serde_json::to_value(&source).ok();
            heddle_agent::run_turn(&runtime, options)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }
}

impl Component for GoalDriverComponent {
    fn requires(&self) -> Vec<String> {
        let mut requires: Vec<String> = AGENT_SERVICES
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        requires.push("goal".to_owned());
        requires
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, _config: &Value, services: &mut Services) -> Result<(), String> {
        let goals = services
            .get::<Arc<heddle_goal::GoalService>>("goal")
            .ok_or_else(|| "goal-driver: the goal service is not provided".to_owned())?;
        let sessions = session_service(services, "goal-driver")?;
        let runtime = crate::runtime::shared_runtime(services)?;
        let driver = heddle_goal::GoalDriver::new(
            goals,
            Arc::new(GoalRounds {
                runtime: Arc::downgrade(&runtime),
                sessions,
            }),
        );
        services.provide("goalDriver", driver);
        Ok(())
    }
}

fn team_port(error: impl std::fmt::Display) -> heddle_team::ports::PortError {
    heddle_team::ports::PortError(error.to_string())
}

/// `heddle-session`'s store as the log `heddle-team` folds a team from and writes its members into.
struct TeamLog {
    store: Arc<heddle_session::SessionStore>,
}

impl TeamLog {
    fn handle(
        &self,
        session: &str,
    ) -> Result<heddle_session::SessionHandle, heddle_team::ports::PortError> {
        self.store
            .open(session)
            .ok_or_else(|| heddle_team::ports::PortError(format!("no session {session}")))
    }
}

impl heddle_team::TeamStore for TeamLog {
    fn exists(&self, session: &str) -> bool {
        self.store.open(session).is_some()
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, heddle_team::ports::PortError> {
        let handle = self.handle(session)?;
        let events = self.store.read(&handle).map_err(team_port)?;
        Ok(events.iter().map(|event| event.to_value()).collect())
    }

    fn meta(&self, session: &str) -> Option<heddle_team::ports::SessionMetaView> {
        self.store
            .meta(session)
            .map(|meta| heddle_team::ports::SessionMetaView {
                id: meta.id().to_owned(),
                cwd: Some(meta.cwd().to_owned()),
                endpoint: meta.endpoint().map(str::to_owned),
                model: meta.model().map(str::to_owned),
                team_id: meta.team_id().map(str::to_owned),
            })
    }

    fn list(&self) -> Vec<String> {
        self.store
            .list()
            .iter()
            .map(|meta| meta.id().to_owned())
            .collect()
    }

    fn create(
        &self,
        child: &heddle_team::ports::ChildSession,
    ) -> Result<(), heddle_team::ports::PortError> {
        self.store
            .create(heddle_session::CreateOptions {
                id: Some(child.id.clone()),
                cwd: child.cwd.clone(),
                endpoint: child.endpoint.clone(),
                model: child.model.clone(),
                title: Some(child.title.clone()),
                parent_session: Some(child.parent_session.clone()),
                origin: Some(heddle_session::SessionOrigin::Subagent),
                delegation_depth: Some(u64::from(child.delegation_depth)),
                team_id: Some(child.team_id.clone()),
                ..heddle_session::CreateOptions::default()
            })
            .map(|_| ())
            .map_err(team_port)
    }

    fn fork(
        &self,
        source: &str,
        child: &heddle_team::ports::ChildSession,
    ) -> Result<bool, heddle_team::ports::PortError> {
        self.store
            .fork(
                source,
                heddle_session::ForkAttribution {
                    parent_session: Some(child.parent_session.clone()),
                    origin: Some(heddle_session::SessionOrigin::Subagent),
                    delegation_depth: Some(u64::from(child.delegation_depth)),
                    team_id: Some(child.team_id.clone()),
                    title: Some(child.title.clone()),
                    id: Some(child.id.clone()),
                },
            )
            .map(|forked| forked.is_some())
            .map_err(team_port)
    }

    fn append(&self, session: &str, event: Value) -> Result<(), heddle_team::ports::PortError> {
        let handle = self.handle(session)?;
        let event = heddle_session::NewEvent::try_from(event).map_err(team_port)?;
        self.store
            .append(&handle, event, heddle_session::AppendOptions::default())
            .map(|_| ())
            .map_err(team_port)
    }

    fn user_message(
        &self,
        session: &str,
        content: Vec<Value>,
        source: Value,
    ) -> Result<(), heddle_team::ports::PortError> {
        let handle = self.handle(session)?;
        let content: Vec<heddle_session::ContentPart> =
            serde_json::from_value(Value::Array(content)).map_err(team_port)?;
        self.store
            .message(
                &handle,
                heddle_session::Message {
                    role: heddle_session::Role::User,
                    tool_call_id: None,
                    content,
                    source: Some(source),
                },
            )
            .map(|_| ())
            .map_err(team_port)
    }

    fn inherit_recorded_mode(
        &self,
        parent: &str,
        child: &str,
    ) -> Result<(), heddle_team::ports::PortError> {
        let parent = self.handle(parent)?;
        let child = self.handle(child)?;
        heddle_session::inherit_recorded_mode::<Value>(&self.store, &parent, &child)
            .map(|_| ())
            .map_err(team_port)
    }
}

/// A teammate's turn on the shared runtime.
struct TeamTurns {
    runtime: std::sync::Weak<heddle_agent::AgentRuntime>,
    store: Arc<heddle_session::SessionStore>,
}

impl heddle_team::plugin::TeamAgent for TeamTurns {
    fn begin_turn(
        &self,
        request: heddle_team::plugin::TeamTurnRequest,
    ) -> Result<heddle_team::ports::TurnFuture, String> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or("the run that owned this team has ended")?;
        let handle = self
            .store
            .open(&request.session)
            .ok_or_else(|| format!("no session {}", request.session))?;
        let mut options =
            heddle_agent::RunTurnOptions::new(handle, request.endpoint, request.prompt);
        options.model = request.model;
        options.purpose = Some(request.purpose.to_owned());
        options.source = Some(request.source);
        Ok(Box::pin(async move {
            heddle_agent::run_turn(&runtime, options)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        }))
    }

    fn default_endpoint(&self) -> Option<String> {
        self.runtime
            .upgrade()
            .and_then(|runtime| runtime.model.default_endpoint())
    }
}

/// `src/plugins/team.ts`: a Lead's teammates, their tasks and their mail, durable in the session log.
pub struct TeamComponent;

impl Component for TeamComponent {
    fn requires(&self) -> Vec<String> {
        AGENT_SERVICES
            .iter()
            .map(|name| (*name).to_owned())
            .collect()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        None
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: heddle_team::TeamConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("team: {error}"))?;
        let store = Arc::clone(session_service(services, "team")?.store());
        let runtime = crate::runtime::shared_runtime(services)?;
        let plugin = heddle_team::TeamPlugin::install(heddle_team::TeamPluginDeps {
            store: Arc::new(TeamLog {
                store: Arc::clone(&store),
            }),
            agent: Arc::new(TeamTurns {
                runtime: Arc::downgrade(&runtime),
                store,
            }),
            live: None,
            config,
            emit_changed: None,
            warn: None,
        });
        let tools = Arc::new(plugin.tools);
        for spec in tools.specs() {
            let spec: heddle_tools::ToolSpec = serde_json::to_value(&spec)
                .and_then(serde_json::from_value)
                .map_err(|error| format!("team: {error}"))?;
            let name = spec.name.clone();
            let tools = Arc::clone(&tools);
            let tool =
                heddle_tools::tool_fn(spec, move |args, context| {
                    let tools = Arc::clone(&tools);
                    let name = name.clone();
                    Box::pin(async move {
                        let caller = context
                            .context()
                            .session
                            .as_ref()
                            .map(|handle| handle.id.clone());
                        let outcome = tools
                            .call(&name, &Value::Object(args), caller.as_deref())
                            .await;
                        let answer = serde_json::to_value(outcome).unwrap_or(Value::Null);
                        Ok(serde_json::from_value::<heddle_tools::ToolResult>(answer)
                            .unwrap_or_else(|error| heddle_tools::ToolResult {
                                output: String::new(),
                                error: Some(heddle_tools::ToolError {
                                    code: "TEAM_FAILED".to_owned(),
                                    message: format!(
                                        "the team tool's answer could not be read: {error}"
                                    ),
                                }),
                                data: None,
                            }))
                    })
                });
            runtime
                .tools
                .register(tool)
                .map_err(|error| format!("team: {error}"))?;
        }
        services.provide("team", Arc::clone(&plugin.service));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "heddle-adapters-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    fn env_at(home: &std::path::Path) -> Env {
        Env::from_pairs([
            ("HEDDLE_HOME", home.to_string_lossy().into_owned()),
            ("HOME", home.to_string_lossy().into_owned()),
        ])
    }

    /// A scripted endpoint's file, which its configuration names as `baseUrl`.
    fn script(home: &std::path::Path) -> String {
        let path = home.join("script.json");
        std::fs::write(&path, json!({ "steps": [] }).to_string()).expect("the script file");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn the_model_row_composes_the_endpoints_and_answers_as_a_port() {
        let home = scratch("model");
        let script = script(&home);
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        component
            .start(
                &json!({
                    "endpoints": [{
                        "name": "double",
                        "kind": "scripted",
                        "baseUrl": script,
                        "model": "scripted",
                    }],
                    "default": "double",
                    "readLocalConfig": false,
                }),
                &mut services,
            )
            .expect("the model row starts");
        let model = services.model().expect("ctx.model is provided");
        let described = model.describe();
        let double = described
            .iter()
            .find(|endpoint| endpoint["name"] == "double")
            .expect("the declared endpoint is described");
        assert_eq!(double["kind"], "scripted");
        let mut names = model.names();
        names.sort();
        assert_eq!(
            names,
            vec!["double".to_owned(), "scripted".to_owned()],
            "the declared endpoint joins the offline default the configuration always offers"
        );
        assert_eq!(
            model.default_endpoint(),
            Some("double".to_owned()),
            "the row's nominated default wins over the first endpoint"
        );
        assert!(
            services
                .get::<Arc<heddle_llm::ModelService>>("model")
                .is_some(),
            "the crate's own handle is registered for another adapter to construct itself with"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_machines_own_file_is_read_when_the_row_asks() {
        let home = scratch("model-local");
        let script = script(&home);
        std::fs::write(
            home.join("heddle.json"),
            json!({
                "endpoints": [{
                    "name": "local",
                    "kind": "scripted",
                    "baseUrl": script,
                    "model": "scripted",
                }],
            })
            .to_string(),
        )
        .expect("the machine's file");
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        component
            .start(&json!({ "endpoints": [] }), &mut services)
            .expect("the model row starts");
        let model = services.model().expect("ctx.model is provided");
        assert!(
            model.names().contains(&"local".to_owned()),
            "the machine's endpoint is offered: {:?}",
            model.names()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_row_that_asks_not_to_read_it_ignores_the_machines_file() {
        let home = scratch("model-no-local");
        let script = script(&home);
        std::fs::write(
            home.join("heddle.json"),
            json!({
                "endpoints": [{
                    "name": "local",
                    "kind": "scripted",
                    "baseUrl": script,
                }],
            })
            .to_string(),
        )
        .expect("the machine's file");
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        component
            .start(
                &json!({
                    "endpoints": [{
                        "name": "declared",
                        "kind": "scripted",
                        "baseUrl": script,
                        "model": "scripted",
                    }],
                    "readLocalConfig": false,
                }),
                &mut services,
            )
            .expect("the model row starts");
        let model = services.model().expect("ctx.model is provided");
        assert!(model.names().contains(&"declared".to_owned()));
        assert!(
            !model.names().contains(&"local".to_owned()),
            "the machine's file was not read: {:?}",
            model.names()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_config_the_row_cannot_hold_fails_naming_the_plugin() {
        let home = scratch("model-bad");
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        let error = component
            .start(
                &json!({ "endpoints": "not a list", "readLocalConfig": false }),
                &mut services,
            )
            .expect_err("a bad config is refused");
        assert!(error.starts_with("model:"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_unknown_endpoint_kind_is_the_configuration_crates_sentence() {
        let home = scratch("model-kind");
        let script = script(&home);
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        let error = component
            .start(
                &json!({
                    "endpoints": [{
                        "name": "odd",
                        "kind": "no-such-kind",
                        "baseUrl": script,
                    }],
                    "readLocalConfig": false,
                }),
                &mut services,
            )
            .expect_err("an unknown kind is refused");
        assert!(error.to_lowercase().contains("no-such-kind"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_sandbox_row_builds_the_service_and_answers_its_root() {
        let home = scratch("sandbox");
        let component = SandboxComponent::new(env_at(&home), home.clone());
        let mut services = Services::new();
        component
            .start(
                &json!({ "mode": "workspace-write", "workspaceRoot": "/work" }),
                &mut services,
            )
            .expect("the sandbox row starts");
        let sandbox = services.sandbox().expect("ctx.sandbox is provided");
        assert_eq!(sandbox.workspace_root(), std::path::PathBuf::from("/work"));
        assert!(
            services
                .get::<Arc<heddle_sandbox::SandboxService>>("sandbox")
                .is_some(),
            "the crate's own handle is registered for the tools and the server"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_workspace_root_falls_back_to_the_runs_directory() {
        let home = scratch("sandbox-cwd");
        let component = SandboxComponent::new(env_at(&home), home.clone());
        let mut services = Services::new();
        component
            .start(&json!({}), &mut services)
            .expect("the sandbox row starts");
        let sandbox = services.sandbox().expect("ctx.sandbox is provided");
        // The service canonicalises its roots (`/var` is `/private/var` on macOS), so the fallback is
        // the run's directory as the filesystem names it.
        assert_eq!(
            sandbox.workspace_root(),
            std::fs::canonicalize(&home).expect("the scratch directory exists")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_mode_outside_the_vocabulary_is_refused_rather_than_widened() {
        let home = scratch("sandbox-mode");
        let component = SandboxComponent::new(env_at(&home), home.clone());
        let mut services = Services::new();
        let error = component
            .start(&json!({ "mode": "wide-open" }), &mut services)
            .expect_err("an unknown mode is refused");
        assert!(error.starts_with("sandbox:"), "{error}");
        assert!(error.contains("wide-open"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_approvals_row_builds_the_policy_service() {
        let component = ApprovalsComponent;
        let mut services = Services::new();
        component
            .start(
                &json!({ "mode": "deny", "allow": ["read_file"], "answerTimeoutMs": 1000 }),
                &mut services,
            )
            .expect("the approvals row starts");
        assert!(
            services
                .get::<Arc<heddle_sandbox::ApprovalService>>("approvals")
                .is_some(),
            "the standing policy is registered for the tools and the server"
        );
    }

    #[test]
    fn an_approvals_mode_outside_the_vocabulary_is_refused() {
        let mut services = Services::new();
        let error = ApprovalsComponent
            .start(&json!({ "mode": "sometimes" }), &mut services)
            .expect_err("an unknown approvals mode is refused");
        assert!(error.starts_with("approvals:"), "{error}");
    }

    #[test]
    fn the_sandbox_row_declares_the_schema_validate_checks_it_against() {
        let schema = sandbox_schema().expect("the sandbox schema parses");
        assert!(
            schema
                .check(&json!({ "mode": "read-only", "backend": "none" }))
                .is_empty()
        );
        assert_eq!(
            schema
                .check(&json!({ "extraWritableRoots": "not a list" }))
                .len(),
            1
        );
    }

    #[test]
    fn the_session_and_workspace_rows_answer_sessions_workspaces_tree_and_file() {
        let home = scratch("session");
        let sessions_root = home.join("sessions");
        let project = home.join("project");
        std::fs::create_dir_all(&project).expect("the project folder");
        std::fs::write(project.join("notes.md"), "hello\n").expect("a file");
        let project = std::fs::canonicalize(&project).expect("canonical");
        let mut services = Services::new();
        SessionComponent::new(env_at(&home))
            .start(&json!({ "root": sessions_root }), &mut services)
            .expect("the session row starts");
        WorkspaceComponent::new(env_at(&home))
            .start(&json!({ "generated": ["dist"] }), &mut services)
            .expect("the workspace row starts");
        let session = services.session().expect("ctx.session");
        let workspace = services.workspace().expect("ctx.workspace");

        assert!(session.list().is_empty());
        let (record, created) = workspace
            .add(&project.to_string_lossy(), Some("Project"))
            .expect("the root registers");
        assert!(created);
        assert_eq!(record["title"], "Project");
        assert_eq!(workspace.list().len(), 1);
        assert_eq!(workspace.generated(), vec!["dist".to_owned()]);

        let (handle, definition) = session
            .create_at(&project, CreateAt::default())
            .expect("session new writes a definition");
        assert!(definition.file.starts_with(&project), "{definition:?}");
        assert_eq!(session.list().len(), 1);
        assert_eq!(session.list()[0]["id"], handle.id.as_str());
        let resumed = session.resume(&handle.id).expect("the session resumes");
        assert_eq!(resumed.id, handle.id);
        assert!(session.resume("no-such-session").is_err());
        assert!(session.events(&resumed).is_ok());

        assert!(workspace.owner(&project.join("notes.md")).is_some());
        assert!(workspace.owner(std::path::Path::new("/nowhere")).is_none());
        let reading = session
            .read_file_text(&project.join("notes.md"))
            .expect("the file reads");
        assert_eq!(reading["text"], "hello\n");
        let roots = vec![TreeRoot {
            path: project.clone(),
            title: "Project".to_owned(),
            origin: None,
        }];
        let node = session
            .tree(Some(&project), &roots, &[], &workspace.generated())
            .expect("the tree answers");
        assert!(node["children"].is_array(), "{node}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_tool_rows_compose_and_the_crates_tools_join_the_registry() {
        use crate::builtins::{BuiltinCatalog, Catalog, ComponentRef, resolve_component};
        let home = scratch("tools");
        let catalog = BuiltinCatalog::new(env_at(&home), home.clone());
        let mut services = Services::new();
        let rows = [
            ("session", json!({ "root": home.join("sessions") })),
            ("sandbox", json!({})),
            ("approvals", json!({})),
            ("tools", json!({})),
            ("todo", json!({})),
            ("todo-tool", json!({})),
            ("goal", json!({})),
            ("goal-tool", json!({})),
            ("turns", json!({})),
            ("model", json!({ "readLocalConfig": false })),
            ("context", json!({})),
            ("subagent-tool", json!({})),
            ("goal-driver", json!({})),
            ("team", json!({})),
            ("greeting", json!({ "punctuation": "?" })),
            ("announce", json!({})),
            ("console", json!({})),
        ];
        for (bare, config) in rows {
            let reference = resolve_component(&heddle_config::ComponentName::Bare(bare.to_owned()));
            assert!(matches!(reference, ComponentRef::Builtin(_)), "{bare}");
            let component = catalog
                .component(&reference)
                .unwrap_or_else(|| panic!("{bare} has an adapter"));
            for name in component.requires() {
                assert!(
                    services.provides(&name),
                    "{bare} waits for {name}, started earlier"
                );
            }
            component
                .start(&config, &mut services)
                .unwrap_or_else(|error| panic!("{bare} starts: {error}"));
        }
        let tools = services.tools().expect("ctx.tools");
        let names: Vec<String> = tools
            .describe()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect();
        for expected in [
            "write_file",
            "read_file",
            "list_dir",
            "bash",
            "todo_write",
            "todo_read",
            "create_goal",
            "get_goal",
            "update_goal",
            "delegate",
            "spawn_teammate",
            "team_task_create",
        ] {
            assert!(
                names.contains(&expected.to_owned()),
                "{expected} in {names:?}"
            );
        }
        assert!(services.goal().is_some());
        assert!(services.provides("turns"));
        assert!(
            services.provides("goalDriver"),
            "the goal driver is composed"
        );
        assert!(
            services.provides("agent-runtime"),
            "the subagent tool and the goal driver share one runtime"
        );
        let greeting = services
            .get::<Arc<Greeting>>("greeting")
            .expect("the greeting service");
        assert_eq!(greeting.greet("heddle"), "hello, heddle?");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_store_log_appends_and_reads_back_an_event_for_the_goal_and_todo_crates() {
        let home = scratch("store-log");
        let sessions = Arc::new(heddle_session::SessionService::new(
            &heddle_session::SessionConfig {
                root: Some(home.join("sessions").to_string_lossy().into_owned()),
            },
            &env_at(&home),
            None,
        ));
        let handle = sessions
            .start(heddle_session::StartOptions {
                cwd: Some(home.to_string_lossy().into_owned()),
                ..heddle_session::StartOptions::default()
            })
            .expect("a session starts");
        let log = StoreLog {
            sessions: Arc::clone(&sessions),
        };
        let id = handle.id.to_string();
        assert_eq!(heddle_todo::SessionLog::open(&log, &id), Some(id.clone()));
        assert_eq!(heddle_todo::SessionLog::open(&log, "nowhere"), None);
        let mut event = serde_json::Map::new();
        event.insert("type".to_owned(), json!("todo/write"));
        event.insert("items".to_owned(), json!([]));
        let written = heddle_goal::SessionLog::append(&log, &id, event).expect("the event lands");
        assert_eq!(written["type"], "todo/write");
        assert!(
            written.get("seq").is_some(),
            "the store assigns seq: {written}"
        );
        let read = heddle_todo::SessionLog::read(&log, &id).expect("the log reads");
        assert_eq!(
            read.last().map(|event| event["type"].clone()),
            Some(json!("todo/write"))
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_context_row_assembles_a_sessions_request_without_calling_a_model() {
        let home = scratch("context");
        let mut services = Services::new();
        ModelComponent::new(env_at(&home))
            .start(&json!({ "readLocalConfig": false }), &mut services)
            .expect("the model row starts");
        SessionComponent::new(env_at(&home))
            .start(&json!({ "root": home.join("sessions") }), &mut services)
            .expect("the session row starts");
        ContextComponent::new(env_at(&home))
            .start(&json!({}), &mut services)
            .expect("the context row starts");
        let session = services.session().expect("ctx.session");
        let handle = session
            .current(&home)
            .expect("a session starts in the folder");
        let report = services
            .context()
            .expect("ctx.context")
            .assemble(
                &handle,
                AssembleOptions {
                    cwd: Some(home.clone()),
                    tools: Vec::new(),
                    endpoint: Some("scripted".to_owned()),
                    model: None,
                },
            )
            .expect("the context assembles");
        assert_eq!(report["session"], handle.id.as_str());
        assert!(report["messageCount"].is_u64(), "{report}");
        assert!(report["estimatedTokens"].is_u64(), "{report}");
        assert!(report["instructions"].is_array(), "{report}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_outside_row_runs_the_program_its_manifest_names_beside_the_manifest() {
        let home = scratch("outside");
        let manifest = home.join("shout.component.yml");
        std::fs::write(
            &manifest,
            "program: ./shout.mjs\nargs: [--loud]\nconfig:\n  type: object\n",
        )
        .expect("the manifest");
        let spec = OutsideRow::new(manifest.clone())
            .spec(&json!({ "level": 3 }))
            .expect("the manifest reads");
        assert_eq!(spec.row, "shout");
        assert_eq!(spec.program, home.join("shout.mjs"));
        assert_eq!(spec.args, vec!["--loud".to_owned()]);
        assert_eq!(spec.cwd, home);
        assert_eq!(spec.config, json!({ "level": 3 }));

        std::fs::write(&manifest, "program: node\nargs: [./shout.mjs]\n").expect("the manifest");
        let spec = OutsideRow::new(manifest)
            .spec(&json!({}))
            .expect("the manifest reads");
        assert_eq!(
            spec.program,
            PathBuf::from("node"),
            "a bare program is looked up as the system would"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_outside_row_whose_manifest_is_missing_fails_naming_it() {
        let home = scratch("outside-missing");
        let error = OutsideRow::new(home.join("nowhere.component.yml"))
            .spec(&json!({}))
            .expect_err("a missing manifest is refused");
        assert!(error.contains("nowhere.component.yml"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_model_row_declares_the_schema_validate_checks_it_against() {
        let schema = model_schema().expect("the model schema parses");
        assert!(
            schema
                .check(&json!({ "endpoints": [], "default": "x" }))
                .is_empty(),
            "a config the row may hold is accepted"
        );
        assert_eq!(
            schema.check(&json!({ "endpoints": "nope" })).len(),
            1,
            "an endpoint list that is not a list is what --validate reports"
        );
    }
}
