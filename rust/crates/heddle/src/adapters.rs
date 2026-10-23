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
    CreateAt, ModelPort, OpenAt, PortError, PortResult, Record, SandboxPort, SessionDefinition,
    SessionHandle, SessionPort, TreeRoot, WorkspacePort,
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
        let service = Arc::new(heddle_session::SessionService::new(
            &config, &self.env, None,
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
