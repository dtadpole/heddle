//! The `jobs` row composed over the crates that own each capability (`src/plugins/jobs.ts`): what the binary calls,
//! with one line, when a profile loads the row.
//!
//! | Seam | Over |
//! |---|---|
//! | owner liveness and the lifecycle events | `heddle-session`'s store: an owner must exist; `job/registered` and `job/settled` are appended to its log |
//! | the three tools | the run's `heddle-tools` registry |
//! | background `bash` | the registry's `bash`, through [`heddle_tools::attach_bash_background`] on the registry's sandbox gate |
//! | the running tool call | the session's own log ([`crate::bash::running_tool_call`]) |
//! | a notice for a running turn | the session inbox's next-step list ([`heddle_session::inbox::queue_steer`]) |
//! | a notice for an idle session | `heddle-agent`'s [`begin_turn`](heddle_agent::begin_turn), purpose `jobs-notice` |
//! | busy and idle | `heddle-agent`'s `TurnRegistry` when the profile loads `turns`; else the session's turn events, forwarded to [`JobsPlugin::on_session_event`] |
//! | the page | [`JobsPlugin::on_change`] for every lifecycle event; the binary forwards it as the SSE event `jobs` |

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;
use heddle_agent::{AgentRuntime, RoundLimit, RunTurnOptions};
use heddle_session::{ContentPart, NewEvent, SessionService, SessionStore};
use heddle_tools::BashBackgroundDetach;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::bash::{BashBackgroundOptions, BashRunner};
use crate::notice::{CompletionDelivery, NoticeDelivery, NoticeHost, NoticeOptions, NoticeSource};
use crate::registry::{
    ControllerAttachment, JobEvent, JobRegistry, JobRegistryOptions, Subscription, Warn,
};
use crate::tools::{JobToolOptions, job_tools};

/// The row's `config` (`src/plugins/jobs.ts`'s schema).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsConfig {
    /// Active (running + stopping) jobs one session may hold, 1 or more; DSH's default is 10.
    #[serde(default)]
    pub max_concurrent_jobs_per_owner: Option<f64>,
    /// Live output kept per job, in UTF-8 bytes; DSH's default is 262144.
    #[serde(default)]
    pub retain_bytes: Option<f64>,
    /// Output kept per job after it settles, in UTF-8 bytes; DSH's default is 16384.
    #[serde(default)]
    pub settled_retain_bytes: Option<f64>,
    /// How often pull sources are drained, in milliseconds; DSH's default is 150.
    #[serde(default)]
    pub pump_poll_ms: Option<f64>,
    /// `job_output`'s wait when `timeout_ms` is absent; DSH's default is 30000.
    #[serde(default)]
    pub wait_timeout_ms: Option<f64>,
    /// The longest wait `job_output` grants; DSH's default is 600000.
    #[serde(default)]
    pub max_wait_timeout_ms: Option<f64>,
    /// `wakeup` starts a turn in an idle owner session; `quiet` only injects into the next step.
    #[serde(default)]
    pub completion_delivery: Option<String>,
    /// Wakes per session before a person writes again; unset is unbounded (DSH's default).
    #[serde(default)]
    pub max_consecutive_wakes: Option<f64>,
    /// Milliseconds between a killed command's SIGTERM and SIGKILL; DSH's 3000.
    #[serde(default)]
    pub kill_grace_ms: Option<f64>,
    /// The round cap of a notice's turn; the loop's own default when absent.
    #[serde(default)]
    pub max_rounds: Option<f64>,
    /// Run foreground `bash` calls as jobs, so one that outlives its wall time moves to the background instead of
    /// being killed: DSH's `promoteOnTimeout` (a `dsh-tool-bash` option there; here the row that owns jobs carries
    /// it). Default true, as DSH's.
    #[serde(default)]
    pub promote_on_timeout: Option<bool>,
}

/// A whole number of at least `min`, or the row's refusal naming the field (the schema's `step(1).min(n)`).
fn whole(field: &str, value: Option<f64>, min: f64) -> Result<Option<u64>, String> {
    match value {
        None => Ok(None),
        Some(number) if number.is_finite() && number.fract() == 0.0 && number >= min => {
            Ok(Some(number as u64))
        }
        Some(number) => Err(format!(
            "jobs: {field} must be a whole number of at least {} (got {})",
            crate::js::json_number(min),
            crate::js::json_number(number)
        )),
    }
}

fn at_least(field: &str, value: Option<f64>, min: f64) -> Result<Option<f64>, String> {
    match value {
        None => Ok(None),
        Some(number) if number.is_finite() && number >= min => Ok(Some(number)),
        Some(number) => Err(format!(
            "jobs: {field} must be at least {} (got {})",
            crate::js::json_number(min),
            crate::js::json_number(number)
        )),
    }
}

/// What the `jobs` row is started from.
pub struct JobsRow<'a> {
    /// The row's `config`; `{}` takes the defaults.
    pub config: &'a Value,
    /// The `session` service.
    pub sessions: Arc<SessionService>,
    /// The run's shared runtime; the row keeps only a weak reference, because the runtime's registry holds the
    /// row's tools, which hold the registry.
    pub runtime: Arc<AgentRuntime>,
    /// Where settles, notices and their turns run; the caller's runtime when absent.
    pub async_runtime: Option<tokio::runtime::Handle>,
    /// Where a contained failure is reported (the TypeScript build logs at warn).
    pub warn: Option<Warn>,
}

/// Events a turn writes; seen while no live-turn registry is present, they mark the session busy.
const TURN_EVENTS: [&str; 4] = [
    "model/request",
    "assistant/chunk",
    "turn/retry",
    "tool/result",
];

/// The started row: `ctx.jobs`, its notices, and what disposal undoes.
pub struct JobsPlugin {
    /// `ctx.jobs`.
    pub registry: JobRegistry,
    /// The completion notices.
    pub delivery: Arc<NoticeDelivery>,
    host: Arc<RuntimeHost>,
    controller: ControllerAttachment,
    bash: BashBackgroundDetach,
    listeners: Mutex<Vec<Subscription>>,
}

impl JobsPlugin {
    /// A session event, as the bus carries it (`session/event`): the turn events stand in for "busy" without a
    /// live-turn registry, a turn's end releases whoever waits for the session to go idle, and a person's message (a
    /// user message no automation wrote) resets the session's wake count.
    pub fn on_session_event(&self, session: &str, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "turn/completed" || kind == "turn/failed" {
            lock(&self.host.in_turn).remove(session);
            let waiters = lock(&self.host.idle_waiters)
                .remove(session)
                .unwrap_or_default();
            for waiter in waiters {
                let _ = waiter.send(());
            }
            return;
        }
        if TURN_EVENTS.contains(&kind) {
            lock(&self.host.in_turn).insert(session.to_owned());
        }
        if kind == "message"
            && let Some(message) = event.get("message")
            && message.get("role").and_then(Value::as_str) == Some("user")
            && message.get("source").is_none_or(Value::is_null)
        {
            self.delivery.reset_wakes(session);
        }
    }

    /// Call `listener` on every lifecycle change (registered, progress, stopping, settled, removed), so the page's
    /// job views refresh; output advances are left to the page's follow poll. Nothing after disposal.
    pub fn on_change(&self, listener: impl Fn() + Send + Sync + 'static) {
        let host = Arc::downgrade(&self.host);
        let subscription = self.registry.subscribe(move |event: &JobEvent| {
            if matches!(event, JobEvent::Output { .. }) {
                return;
            }
            if host
                .upgrade()
                .is_none_or(|host| host.disposed.load(Ordering::SeqCst))
            {
                return;
            }
            listener();
        });
        lock(&self.listeners).push(subscription);
    }

    /// The row's teardown: background `bash` detached, notices stopped, the tools' controller detached, and every
    /// live job cancelled with `jobs service disposed` (no notice for any of them).
    pub fn dispose(&self) {
        if self.host.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.bash.detach();
        self.delivery.dispose();
        for listener in lock(&self.listeners).drain(..) {
            listener.unsubscribe();
        }
        self.controller.detach();
        self.registry.dispose_in_background();
    }
}

/// Disposes the row when it is dropped — what the binary provides beside the row, so the boot's disposal (the
/// TypeScript `ctx.effect` teardown) stops every live job.
pub struct JobsTeardown(pub Arc<JobsPlugin>);

impl Drop for JobsTeardown {
    fn drop(&mut self) {
        self.0.dispose();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start the `jobs` row: the registry, the notices, the three tools in the runtime's registry and background
/// `bash`. `Err` is the sentence the boot reports for a failed row.
pub fn start_row(row: JobsRow<'_>) -> Result<Arc<JobsPlugin>, String> {
    let config: JobsConfig =
        serde_json::from_value(row.config.clone()).map_err(|error| format!("jobs: {error}"))?;
    let max_jobs = whole(
        "maxConcurrentJobsPerOwner",
        config.max_concurrent_jobs_per_owner,
        1.0,
    )?;
    let retain_bytes = whole("retainBytes", config.retain_bytes, 1.0)?;
    let settled_retain_bytes = whole("settledRetainBytes", config.settled_retain_bytes, 1.0)?;
    let pump_poll_ms = whole("pumpPollMs", config.pump_poll_ms, 1.0)?;
    let wait_timeout_ms = at_least("waitTimeoutMs", config.wait_timeout_ms, 1.0)?;
    let max_wait_timeout_ms = at_least("maxWaitTimeoutMs", config.max_wait_timeout_ms, 1.0)?;
    let kill_grace_ms = at_least("killGraceMs", config.kill_grace_ms, 0.0)?;
    let completion_delivery = match config.completion_delivery.as_deref() {
        None | Some("wakeup") => CompletionDelivery::Wakeup,
        Some("quiet") => CompletionDelivery::Quiet,
        Some(other) => {
            return Err(format!(
                "jobs: completionDelivery must be 'wakeup' or 'quiet' (got '{other}')"
            ));
        }
    };
    let warn: Warn = row
        .warn
        .unwrap_or_else(|| Arc::new(|message: &str| tracing::warn!("{message}")));
    let async_runtime = row
        .async_runtime
        .or_else(|| tokio::runtime::Handle::try_current().ok());
    let store = Arc::clone(row.sessions.store());

    let exists = Arc::clone(&store);
    let recorder = Arc::clone(&store);
    let registry = JobRegistry::new(JobRegistryOptions {
        session_exists: Some(Arc::new(move |id: &str| exists.open(id).is_some())),
        record: Some(Arc::new(move |session: &str, kind: &str, data| {
            let handle = recorder
                .open(session)
                .ok_or_else(|| format!("session \"{session}\" is not available"))?;
            let mut event = NewEvent::new(kind);
            event.fields = data;
            recorder
                .append(&handle, event, heddle_session::AppendOptions::default())
                .map(|_| ())
                .map_err(|error| error.to_string())
        })),
        warn: Some(Arc::clone(&warn)),
        max_concurrent_jobs_per_owner: max_jobs.map(|max| max as usize),
        retain_bytes,
        settled_retain_bytes,
        pump_poll_ms,
        random_hex: None,
        runtime: async_runtime.clone(),
    });

    let host = Arc::new(RuntimeHost {
        runtime: Arc::downgrade(&row.runtime),
        store: Arc::clone(&store),
        in_turn: Mutex::new(HashSet::new()),
        idle_waiters: Mutex::new(HashMap::new()),
        disposed: AtomicBool::new(false),
        max_rounds: config
            .max_rounds
            .filter(|rounds| rounds.is_finite() && *rounds >= 0.0)
            .map(|rounds| rounds.min(f64::from(u32::MAX)) as u32),
        async_runtime: async_runtime.clone(),
        warn: Arc::clone(&warn),
    });
    let delivery = Arc::new(NoticeDelivery::new(
        &registry,
        host.clone(),
        NoticeOptions {
            completion_delivery,
            max_consecutive_wakes: config.max_consecutive_wakes,
        },
        async_runtime,
    )?);

    let controller = registry.attach_controller("tool-jobs");
    let tools = job_tools(
        registry.clone(),
        JobToolOptions {
            wait_timeout_ms,
            max_wait_timeout_ms,
            on_model_kill: Some(delivery.model_kill_marker()),
        },
    )?;
    for tool in tools {
        row.runtime
            .tools
            .register(tool)
            .map_err(|error| format!("jobs: {error}"))?;
    }
    let reader = Arc::clone(&store);
    let bash = heddle_tools::attach_bash_background(
        row.runtime.tools.sandbox(),
        Arc::new(BashRunner::new(
            registry.clone(),
            BashBackgroundOptions {
                read_log: Some(Arc::new(move |handle| reader.read(handle).ok())),
                kill_grace_ms: kill_grace_ms.map(|grace| grace.round() as u64),
                on_spawn: None,
                promote_on_timeout: config.promote_on_timeout,
            },
        )),
    );
    Ok(Arc::new(JobsPlugin {
        registry,
        delivery,
        host,
        controller,
        bash,
        listeners: Mutex::new(Vec::new()),
    }))
}

/// [`NoticeHost`] over the session store and the shared runtime.
struct RuntimeHost {
    runtime: Weak<AgentRuntime>,
    store: Arc<SessionStore>,
    /// Sessions whose turn events say a turn is in flight, for a profile without a live-turn registry.
    in_turn: Mutex<HashSet<String>>,
    idle_waiters: Mutex<HashMap<String, Vec<oneshot::Sender<()>>>>,
    disposed: AtomicBool,
    max_rounds: Option<u32>,
    async_runtime: Option<tokio::runtime::Handle>,
    warn: Warn,
}

impl RuntimeHost {
    fn turns(&self) -> Option<heddle_agent::TurnRegistry> {
        self.runtime
            .upgrade()
            .and_then(|runtime| runtime.turns.clone())
    }

    fn begin(
        &self,
        session_id: &str,
        text: &str,
        source: &NoticeSource,
        answer_pending: bool,
    ) -> Result<(), String> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(());
        };
        let Some(handle) = self.store.open(session_id) else {
            return Ok(());
        };
        let meta = self.store.meta(session_id);
        let Some(endpoint) = meta
            .as_ref()
            .and_then(|meta| meta.endpoint().map(str::to_owned))
            .or_else(|| runtime.model.default_endpoint())
        else {
            (self.warn)(&format!(
                "jobs: no endpoint is configured for a completion-notice turn in session {session_id}"
            ));
            return Ok(());
        };
        let spawner = self
            .async_runtime
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
            .ok_or("no async runtime is running to start a completion-notice turn")?;
        let mut options = RunTurnOptions::new(handle, endpoint, text);
        options.source = Some(source.to_value());
        options.purpose = Some("jobs-notice".to_owned());
        options.answer_pending = answer_pending;
        options.model = meta
            .as_ref()
            .and_then(|meta| meta.model().map(str::to_owned));
        options.reasoning_effort = meta
            .as_ref()
            .and_then(|meta| meta.reasoning_effort().map(str::to_owned));
        if let Some(rounds) = self.max_rounds {
            options.max_rounds = RoundLimit::Rounds(rounds);
        }
        // Started, not awaited, as the schedule row starts a reminder's turn: the user message and the live
        // registration are durable when begin returns, which is all delivery needs, and a later notice must find
        // this turn running and be injected.
        let begun =
            heddle_agent::begin_turn(&runtime, options).map_err(|error| error.to_string())?;
        let warn = Arc::clone(&self.warn);
        let session = session_id.to_owned();
        spawner.spawn(async move {
            if let Err(error) = begun.run().await {
                warn(&format!(
                    "jobs: the completion-notice turn in session {session} failed — {error}"
                ));
            }
        });
        Ok(())
    }
}

impl NoticeHost for RuntimeHost {
    fn exists(&self, session: &str) -> bool {
        self.store.open(session).is_some()
    }

    fn is_running(&self, session: &str) -> bool {
        match self.turns() {
            Some(turns) => turns.is_running(session),
            None => lock(&self.in_turn).contains(session),
        }
    }

    fn when_idle(&self, session: &str) -> BoxFuture<'static, ()> {
        if let Some(turns) = self.turns() {
            let session = session.to_owned();
            return Box::pin(async move { turns.when_idle(&session).await });
        }
        if !lock(&self.in_turn).contains(session) {
            return Box::pin(async {});
        }
        let (sender, receiver) = oneshot::channel();
        lock(&self.idle_waiters)
            .entry(session.to_owned())
            .or_default()
            .push(sender);
        Box::pin(async move {
            let _ = receiver.await;
        })
    }

    fn inject(&self, session: &str, text: &str, source: &NoticeSource) -> Result<String, String> {
        let handle = self
            .store
            .open(session)
            .ok_or_else(|| format!("session \"{session}\" is not available"))?;
        heddle_session::inbox::queue_steer(
            &self.store,
            &handle,
            vec![ContentPart::text(text)],
            Some(source.to_value()),
        )
        .map(|message| message.id)
        .map_err(|error| error.to_string())
    }

    fn is_pending(&self, session: &str, message_id: &str) -> bool {
        self.store.open(session).is_some_and(|handle| {
            heddle_session::inbox::pending_inbox(&self.store, &handle).is_ok_and(|inbox| {
                inbox
                    .next_step
                    .iter()
                    .any(|message| message.id == message_id)
            })
        })
    }

    fn wake(&self, session: &str, text: &str, source: &NoticeSource, answer_pending: bool) {
        if self.disposed.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = self.begin(session, text, source, answer_pending) {
            (self.warn)(&format!(
                "jobs: the completion-notice turn in session {session} failed — {error}"
            ));
        }
    }

    fn warn(&self, message: &str) {
        (self.warn)(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::tests::manual_spec;
    use crate::registry::{JobOutcome, OutcomeStatus};
    use heddle_agent::{ContextPort, LlmModel, PortError};
    use heddle_config::Env;
    use heddle_session::{CreateOptions, SessionConfig, SessionHandle};
    use heddle_tools::{ToolContext, ToolRegistry};
    use serde_json::json;
    use std::time::Duration;

    struct PromptOnly;

    fn report() -> heddle_agent::upstream::ContextReport {
        heddle_agent::upstream::ContextReport {
            messages: vec![heddle_llm::Message::new(
                heddle_llm::Role::User,
                vec![heddle_llm::ContentPart::Text {
                    text: "continue".into(),
                }],
            )],
            ..Default::default()
        }
    }

    impl ContextPort for PromptOnly {
        fn record_runtime_context(
            &self,
            _session: &SessionHandle,
            _sections: &[heddle_agent::upstream::RuntimeContextSection],
        ) -> Result<(), PortError> {
            Ok(())
        }

        fn prepare<'a>(
            &'a self,
            _session: &'a SessionHandle,
            _options: heddle_agent::upstream::PrepareOptions,
        ) -> BoxFuture<'a, Result<heddle_agent::upstream::ContextReport, PortError>> {
            Box::pin(async { Ok(report()) })
        }

        fn assemble(
            &self,
            _session: &SessionHandle,
            _options: heddle_agent::upstream::PrepareOptions,
        ) -> Result<heddle_agent::upstream::ContextReport, PortError> {
            Ok(report())
        }
    }

    /// A scratch folder removed when dropped.
    struct Scratch(std::path::PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(label: &str) -> Scratch {
        use std::sync::atomic::AtomicUsize;
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "heddle-jobs-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    pub(crate) struct Fixture {
        pub sessions: Arc<SessionService>,
        pub runtime: Arc<AgentRuntime>,
        pub script: std::path::PathBuf,
        pub work: std::path::PathBuf,
        _root: Scratch,
    }

    /// A real session store, a scripted endpoint, the real built-in tools over a danger-full-access sandbox, and the
    /// live-turn registry when `turns`.
    pub(crate) fn fixture(label: &str, turns: bool) -> Fixture {
        let root = scratch(label);
        let work = root.0.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let script = root.0.join("scripted.json");
        std::fs::write(&script, r#"{"steps":[{"text":"noted"}]}"#).unwrap();
        let model = Arc::new(
            heddle_llm::ModelService::new(vec![heddle_llm::EndpointConfig {
                name: "scripted".into(),
                kind: heddle_llm::EndpointKind::Scripted,
                base_url: script.display().to_string(),
                model: Some("scripted".into()),
                ..heddle_llm::EndpointConfig::default()
            }])
            .unwrap(),
        );
        let config: SessionConfig =
            serde_json::from_value(json!({"root": root.0.join("sessions").display().to_string()}))
                .unwrap();
        let sessions = Arc::new(SessionService::new(&config, &Env::default(), None));
        let sandbox_config: heddle_sandbox::SandboxConfig = serde_json::from_value(json!({
            "mode": "danger-full-access",
            "workspaceRoot": work.display().to_string(),
            "backend": "none"
        }))
        .unwrap();
        let host = heddle_sandbox::SandboxHost::detect(root.0.join("home")).unwrap();
        let sandbox = Arc::new(heddle_sandbox::SandboxService::new(&sandbox_config, &host));
        let approvals: heddle_sandbox::ApprovalsConfig =
            serde_json::from_value(json!({"mode": "allow"})).unwrap();
        let gates = heddle_tools::ToolGates {
            approvals: Arc::new(heddle_tools::adapters::SandboxApprovals::new(Arc::new(
                heddle_sandbox::ApprovalService::new(approvals),
            ))),
            sandbox: Arc::new(heddle_tools::adapters::Sandbox::new(sandbox)),
            modes: Arc::new(heddle_tools::DefaultModes),
            hooks: Arc::new(heddle_tools::NoToolHooks),
        };
        let tools = ToolRegistry::from_config(gates, &heddle_tools::ToolsConfig::default());
        let runtime = Arc::new(AgentRuntime {
            model: Arc::new(LlmModel::new(model)),
            session: Arc::new(heddle_agent::adapters::Sessions::new(sessions.clone())),
            context: Arc::new(PromptOnly),
            tools: Arc::new(tools),
            hooks: Arc::new(heddle_agent::NoTurnHooks),
            turns: turns.then(heddle_agent::TurnRegistry::new),
        });
        Fixture {
            sessions,
            runtime,
            script,
            work,
            _root: root,
        }
    }

    pub(crate) fn start(fixture: &Fixture, config: Value) -> Arc<JobsPlugin> {
        start_row(JobsRow {
            config: &config,
            sessions: Arc::clone(&fixture.sessions),
            runtime: Arc::clone(&fixture.runtime),
            async_runtime: None,
            warn: None,
        })
        .unwrap()
    }

    pub(crate) fn session(fixture: &Fixture) -> SessionHandle {
        fixture
            .sessions
            .store()
            .create(CreateOptions {
                cwd: Some(fixture.work.display().to_string()),
                endpoint: Some("scripted".into()),
                ..CreateOptions::default()
            })
            .unwrap()
    }

    fn events(
        fixture: &Fixture,
        session: &SessionHandle,
    ) -> Vec<Arc<heddle_session::SessionEvent>> {
        fixture.sessions.store().read(session).unwrap().to_vec()
    }

    fn user_messages(fixture: &Fixture, session: &SessionHandle) -> Vec<Value> {
        events(fixture, session)
            .iter()
            .filter(|event| event.kind == "message")
            .filter_map(|event| event.get("message").cloned())
            .filter(|message| message["role"] == "user")
            .collect()
    }

    async fn until(what: &str, condition: impl Fn() -> bool) {
        for _ in 0..500 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn call_context(fixture: &Fixture, session: &SessionHandle) -> ToolContext {
        ToolContext::new(fixture.work.clone()).with_session(session.clone())
    }

    async fn call(
        fixture: &Fixture,
        session: &SessionHandle,
        name: &str,
        args: Value,
    ) -> heddle_tools::ToolResult {
        fixture
            .runtime
            .tools
            .call(
                name,
                args.as_object().cloned().unwrap(),
                call_context(fixture, session),
            )
            .await
    }

    fn job_id(output: &str) -> String {
        let id = output
            .strip_prefix("started background job ")
            .unwrap_or_else(|| panic!("not a start answer: {output}"));
        assert!(id.starts_with("bash-") && id.len() == 21, "{id}");
        id.to_owned()
    }

    async fn settled_in_log(fixture: &Fixture, session: &SessionHandle, id: &str) -> Value {
        for _ in 0..1000 {
            let found = events(fixture, session).iter().find_map(|event| {
                (event.kind == "job/settled" && event.get("jobId") == Some(&json!(id)))
                    .then(|| Value::Object(event.fields.clone()))
            });
            if let Some(found) = found {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {id} never settled");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_row_registers_the_tools_and_gives_bash_its_background_half() {
        let fixture = fixture("row", true);
        let before = fixture.runtime.tools.get("bash").unwrap().spec().clone();
        let plugin = start(&fixture, json!({}));
        let names = fixture.runtime.tools.names();
        for name in ["job_output", "job_list", "job_kill"] {
            assert!(names.contains(&name.to_owned()), "{name} in {names:?}");
        }
        let bash = fixture.runtime.tools.get("bash").unwrap();
        assert!(bash.spec().parameters["properties"]["run_in_background"].is_object());
        let handle = session(&fixture);
        let started = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "echo hi", "run_in_background": true }),
        )
        .await;
        let id = job_id(&started.output);
        assert_eq!(started.data.as_ref().unwrap()["jobId"], json!(id));
        let waited = call(
            &fixture,
            &handle,
            "job_output",
            json!({ "job_id": id, "wait": true, "timeout_ms": 5000 }),
        )
        .await;
        assert_eq!(waited.output, "hi\n[status: completed, exit code: 0]");
        plugin.dispose();
        assert_eq!(*fixture.runtime.tools.get("bash").unwrap().spec(), before);
    }

    /// DSH's promoted answer: the output so far, the marker, and the hand-off; the job id is captured.
    fn promoted_id(output: &str, timeout_ms: u64) -> (String, String) {
        let marker = format!("[still running after {timeout_ms}ms; moved to background job ");
        let at = output
            .find(&marker)
            .unwrap_or_else(|| panic!("not a promoted answer: {output:?}"));
        let rest = &output[at + marker.len()..];
        let id = rest[..21].to_owned();
        assert!(id.starts_with("bash-"), "{id}");
        assert_eq!(
            &rest[21..],
            "]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill."
        );
        (output[..at].to_owned(), id)
    }

    #[test]
    fn render_promoted_is_dsh_s_text() {
        let tail = "The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.";
        assert_eq!(
            crate::bash::render_promoted("", 500, "bash-x"),
            format!("[still running after 500ms; moved to background job bash-x]\n{tail}")
        );
        assert_eq!(
            crate::bash::render_promoted("early", 500, "bash-x"),
            format!("early\n[still running after 500ms; moved to background job bash-x]\n{tail}")
        );
        assert_eq!(
            crate::bash::render_promoted("early\n", 500, "bash-x"),
            format!("early\n[still running after 500ms; moved to background job bash-x]\n{tail}")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_foreground_call_that_ends_in_time_answers_as_one_and_leaves_no_job() {
        let fixture = fixture("promote-in-time", true);
        let plugin = start(&fixture, json!({}));
        let handle = session(&fixture);
        let ok = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "echo out; echo err >&2" }),
        )
        .await;
        assert_eq!(ok.output, "out\nerr\n");
        assert!(ok.error.is_none(), "{ok:?}");
        assert_eq!(
            ok.data.as_ref().and_then(|data| data.get("exitCode")),
            Some(&json!(0))
        );
        let failed = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "echo x; exit 3" }),
        )
        .await;
        assert_eq!(failed.output, "x\n");
        assert_eq!(
            failed.error.as_ref().map(|error| error.code.as_str()),
            Some("EXIT")
        );
        assert!(
            plugin.registry.list(Some(&handle.id)).is_empty(),
            "the records were removed"
        );
        let kinds: Vec<String> = events(&fixture, &handle)
            .iter()
            .map(|event| event.kind.clone())
            .collect();
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| *kind == "job/registered")
                .count(),
            2
        );
        assert_eq!(
            kinds.iter().filter(|kind| *kind == "job/settled").count(),
            2
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            user_messages(&fixture, &handle).is_empty(),
            "each settle was the call's own, so no notice"
        );
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_foreground_call_that_outlives_its_wall_time_moves_to_a_background_job() {
        let fixture = fixture("promote-late", true);
        let plugin = start(&fixture, json!({}));
        let handle = session(&fixture);
        let began = std::time::Instant::now();
        let answer = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "echo early; sleep 0.8; echo late", "timeoutMs": 300 }),
        )
        .await;
        assert!(began.elapsed() < Duration::from_secs(2));
        assert!(answer.error.is_none(), "{answer:?}");
        let (before, id) = promoted_id(&answer.output, 300);
        assert_eq!(before, "early\n");
        assert_eq!(
            answer.data.as_ref().and_then(|data| data.get("promoted")),
            Some(&json!(true))
        );
        assert_eq!(
            call(&fixture, &handle, "job_list", json!({})).await.output,
            format!("{id} [bash] running — echo early; sleep 0.8; echo late")
        );
        let read = call(
            &fixture,
            &handle,
            "job_output",
            json!({ "job_id": id, "wait": true, "timeout_ms": 5000 }),
        )
        .await;
        assert_eq!(read.output, "late\n[status: completed, exit code: 0]");
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_promoted_job_that_ends_on_its_own_sends_the_completion_notice() {
        let fixture = fixture("promote-notice", true);
        let plugin = start(&fixture, json!({}));
        let handle = session(&fixture);
        let answer = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "sleep 0.5; echo done", "timeoutMs": 150 }),
        )
        .await;
        let (_, id) = promoted_id(&answer.output, 150);
        let settled = settled_in_log(&fixture, &handle, &id).await;
        assert_eq!(settled["status"], "completed");
        until("the completion notice", || {
            user_messages(&fixture, &handle).iter().any(|message| {
                message.to_string().contains(&format!(
                    "background job {id} (bash: sleep 0.5; echo done) finished"
                ))
            })
        })
        .await;
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_during_the_wait_kills_the_group_and_answers_stopped() {
        let fixture = fixture("promote-stop", true);
        let plugin = start(&fixture, json!({ "killGraceMs": 200 }));
        let handle = session(&fixture);
        let token = heddle_tools::CancellationToken::new();
        let stopper = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stopper.cancel();
        });
        let answer = fixture
            .runtime
            .tools
            .call(
                "bash",
                json!({ "command": "echo before; sleep 30" })
                    .as_object()
                    .cloned()
                    .unwrap(),
                call_context(&fixture, &handle).with_cancel(token),
            )
            .await;
        assert_eq!(
            answer.error.as_ref().map(|error| error.code.as_str()),
            Some("INTERRUPTED"),
            "{answer:?}"
        );
        assert!(
            plugin.registry.list(Some(&handle.id)).is_empty(),
            "the record was removed"
        );
        let settled = events(&fixture, &handle)
            .iter()
            .find(|event| event.kind == "job/settled")
            .map(|event| Value::Object(event.fields.clone()))
            .expect("the job settled before the call answered");
        assert_eq!(settled["detail"], "signal: SIGTERM; tool call aborted");
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_promote_on_timeout_false_the_wall_time_kills_as_without_the_row() {
        let fixture = fixture("promote-off", true);
        let plugin = start(&fixture, json!({ "promoteOnTimeout": false }));
        let handle = session(&fixture);
        let answer = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "echo early; sleep 30", "timeoutMs": 200 }),
        )
        .await;
        assert_eq!(
            answer.error.as_ref().map(|error| error.code.as_str()),
            Some("TIMEOUT"),
            "{answer:?}"
        );
        assert!(
            events(&fixture, &handle)
                .iter()
                .all(|event| event.kind != "job/registered")
        );
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sleep_30_in_the_background_is_killed_with_its_process_group() {
        let fixture = fixture("kill", true);
        let pids: Arc<Mutex<HashMap<String, i32>>> = Arc::new(Mutex::new(HashMap::new()));
        let plugin = start(&fixture, json!({}));
        // Re-attach with a spawn observer, so the test can watch the process group.
        let seen = Arc::clone(&pids);
        let store = Arc::clone(fixture.sessions.store());
        let detach = heddle_tools::attach_bash_background(
            fixture.runtime.tools.sandbox(),
            Arc::new(BashRunner::new(
                plugin.registry.clone(),
                BashBackgroundOptions {
                    read_log: Some(Arc::new(move |handle| store.read(handle).ok())),
                    kill_grace_ms: None,
                    on_spawn: Some(Arc::new(move |id: &str, pid: i32| {
                        lock(&seen).insert(id.to_owned(), pid);
                    })),
                    promote_on_timeout: None,
                },
            )),
        );
        let handle = session(&fixture);
        let began = std::time::Instant::now();
        let started = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "sleep 30", "run_in_background": true }),
        )
        .await;
        assert!(
            began.elapsed() < Duration::from_secs(2),
            "the call did not wait for the command"
        );
        assert!(started.error.is_none(), "{started:?}");
        let id = job_id(&started.output);
        let pid = *lock(&pids).get(&id).expect("the spawn was observed");
        assert!(
            crate::bash::group_alive(pid),
            "the command runs in its own process group"
        );
        assert_eq!(
            call(&fixture, &handle, "job_list", json!({})).await.output,
            format!("{id} [bash] running — sleep 30")
        );
        assert_eq!(
            call(&fixture, &handle, "job_output", json!({ "job_id": id }))
                .await
                .output,
            "(no new output)\n[status: running]"
        );
        let killed = call(&fixture, &handle, "job_kill", json!({ "job_id": id })).await;
        assert_eq!(killed.output, format!("requested cancellation of job {id}"));
        let settled = settled_in_log(&fixture, &handle, &id).await;
        assert_eq!(settled["status"], "killed");
        assert_eq!(settled["detail"], "signal: SIGTERM");
        assert_eq!(settled["cause"], "kill");
        assert!(!crate::bash::group_alive(pid), "the process group is gone");
        assert_eq!(
            call(&fixture, &handle, "job_kill", json!({ "job_id": id }))
                .await
                .output,
            format!("job {id} had already finished [status: killed, signal: SIGTERM]")
        );
        assert_eq!(
            call(&fixture, &handle, "job_list", json!({})).await.output,
            format!("{id} [bash] killed — sleep 30")
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            user_messages(&fixture, &handle).is_empty(),
            "the model killed it itself, so no completion notice"
        );
        detach.detach();
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_command_that_ignores_sigterm_is_killed_with_sigkill_after_the_grace_period() {
        let fixture = fixture("grace", true);
        let plugin = start(&fixture, json!({ "killGraceMs": 200 }));
        let handle = session(&fixture);
        let started = call(
            &fixture,
            &handle,
            "bash",
            json!({ "command": "trap '' TERM; sleep 30 & echo $$ > group.pid; wait", "run_in_background": true }),
        )
        .await;
        let id = job_id(&started.output);
        let pid_file = fixture.work.join("group.pid");
        until("the job to write its pid", || pid_file.exists()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        plugin.registry.kill(&id, Some(&handle.id), None).unwrap();
        let settled = settled_in_log(&fixture, &handle, &id).await;
        assert_eq!(settled["status"], "killed");
        let detail = settled["detail"].as_str().unwrap();
        assert!(
            detail == "signal: SIGKILL" || detail == "signal: SIGTERM",
            "{detail}"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !crate::bash::group_alive(pid),
            "nothing of the group survives"
        );
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exit_3_settles_completed_and_job_output_reads_only_new_output() {
        let fixture = fixture("exit", true);
        let plugin = start(&fixture, json!({}));
        let handle = session(&fixture);
        let id = job_id(
            &call(
                &fixture,
                &handle,
                "bash",
                json!({ "command": "echo x; echo oops >&2; exit 3", "run_in_background": true }),
            )
            .await
            .output,
        );
        let settled = settled_in_log(&fixture, &handle, &id).await;
        assert_eq!(settled["status"], "completed");
        assert_eq!(settled["detail"], "exit code: 3");
        assert_eq!(
            call(&fixture, &handle, "job_output", json!({ "job_id": id }))
                .await
                .output,
            "x\n[stderr]\noops\n[status: completed, exit code: 3]"
        );
        assert_eq!(
            call(&fixture, &handle, "job_output", json!({ "job_id": id }))
                .await
                .output,
            "(no new output)\n[status: completed, exit code: 3]"
        );

        let id = job_id(
            &call(&fixture, &handle, "bash", json!({ "command": "echo one; sleep 0.3; echo two; sleep 30", "run_in_background": true }))
                .await
                .output,
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            call(&fixture, &handle, "job_output", json!({ "job_id": id }))
                .await
                .output,
            "one\n[status: running]"
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            call(&fixture, &handle, "job_output", json!({ "job_id": id }))
                .await
                .output,
            "two\n[status: running]"
        );
        let waited = std::time::Instant::now();
        assert_eq!(
            call(
                &fixture,
                &handle,
                "job_output",
                json!({ "job_id": id, "wait": true, "timeout_ms": 100 })
            )
            .await
            .output,
            "(no new output)\n[status: running]"
        );
        assert!(waited.elapsed() >= Duration::from_millis(90));
        plugin.registry.kill(&id, Some(&handle.id), None).unwrap();
        settled_in_log(&fixture, &handle, &id).await;
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ownership_spawn_failure_and_the_logged_tool_call() {
        let fixture = fixture("owner", true);
        let plugin = start(&fixture, json!({}));
        let a = session(&fixture);
        let b = session(&fixture);
        // The model's answer, as the loop records it, before the tool runs.
        let store = fixture.sessions.store();
        store
            .append(
                &a,
                NewEvent::new("model/request").field("endpoint", "fake"),
                heddle_session::AppendOptions::default(),
            )
            .unwrap();
        store
            .append(
                &a,
                NewEvent::new("assistant/chunk").field(
                    "chunk",
                    json!({ "type": "tool-call", "id": "call_x", "name": "bash", "arguments": "{\"command\":\"sleep 30\",\"run_in_background\":true}" }),
                ),
                heddle_session::AppendOptions::default(),
            )
            .unwrap();
        let id = job_id(
            &call(
                &fixture,
                &a,
                "bash",
                json!({ "command": "sleep 30", "run_in_background": true }),
            )
            .await
            .output,
        );
        let foreign = format!("job {id} belongs to another session");
        let read = call(&fixture, &b, "job_output", json!({ "job_id": id })).await;
        assert_eq!(read.error.unwrap().message, foreign);
        let kill = call(&fixture, &b, "job_kill", json!({ "job_id": id })).await;
        let error = kill.error.unwrap();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("JOB_FOREIGN", foreign.as_str())
        );
        assert_eq!(
            call(&fixture, &b, "job_list", json!({})).await.output,
            "(no background jobs)"
        );
        let unknown = call(
            &fixture,
            &a,
            "job_output",
            json!({ "job_id": "bash-0000000000000000" }),
        )
        .await;
        assert_eq!(
            unknown.error.unwrap().message,
            "unknown job bash-0000000000000000"
        );
        let empty = call(&fixture, &a, "job_output", json!({ "job_id": "" })).await;
        assert_eq!(
            empty.error.unwrap().message,
            "invalid job_id: expected a non-empty string, got \"\""
        );
        let registered = events(&fixture, &a)
            .iter()
            .find(|event| event.kind == "job/registered")
            .cloned()
            .unwrap();
        assert_eq!(registered.get("jobId"), Some(&json!(id)));
        assert_eq!(registered.get("owner"), Some(&json!(a.id)));
        assert_eq!(registered.get("label"), Some(&json!("sleep 30")));
        assert_eq!(
            registered.get("toolCall"),
            Some(&json!({ "callId": "call_x", "rootCallId": "call_x" }))
        );
        plugin.registry.kill(&id, Some(&a.id), None).unwrap();
        settled_in_log(&fixture, &a, &id).await;

        let missing = fixture.work.join("no-such-folder");
        let result = fixture
            .runtime
            .tools
            .call(
                "bash",
                json!({ "command": "echo hi", "run_in_background": true })
                    .as_object()
                    .cloned()
                    .unwrap(),
                ToolContext::new(missing).with_session(a.clone()),
            )
            .await;
        let id = job_id(&result.output);
        let settled = settled_in_log(&fixture, &a, &id).await;
        assert_eq!(settled["status"], "failed");
        assert!(
            settled["detail"].as_str().unwrap().contains("ENOENT"),
            "{settled}"
        );
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_idle_session_is_woken_by_a_turn_whose_prompt_is_the_notice() {
        let fixture = fixture("wake", true);
        let changed = Arc::new(Mutex::new(0usize));
        let plugin = start(&fixture, json!({}));
        let count = Arc::clone(&changed);
        plugin.on_change(move || *lock(&count) += 1);
        std::fs::write(
            &fixture.script,
            r#"{"steps":[{"purpose":"jobs-notice","text":"noted"}]}"#,
        )
        .unwrap();
        let handle = session(&fixture);
        let (spec, producer) = manual_spec(Some(&handle.id), "make build", None);
        let id = plugin.registry.start(spec).unwrap();
        producer.finish(JobOutcome::new(
            OutcomeStatus::Completed,
            Some("exit code: 0"),
        ));
        until("the notice turn to complete", || {
            events(&fixture, &handle)
                .iter()
                .any(|event| event.kind == "turn/completed")
        })
        .await;
        let all = events(&fixture, &handle);
        assert!(
            all.iter()
                .any(|event| event.kind == "job/registered"
                    && event.get("jobId") == Some(&json!(id)))
        );
        assert!(
            all.iter()
                .any(|event| event.kind == "job/settled" && event.get("jobId") == Some(&json!(id)))
        );
        let users = user_messages(&fixture, &handle);
        assert_eq!(
            users[0]["source"],
            json!({ "kind": "tool-jobs", "form": "notice", "summary": "bash make build [status: completed, exit code: 0]" })
        );
        assert_eq!(
            users[0]["content"][0]["text"],
            format!(
                "background job {id} (bash: make build) finished [status: completed, exit code: 0]. Read its output with job_output."
            )
        );
        let requests: Vec<Value> = all
            .iter()
            .filter(|event| event.kind == "model/request")
            .map(|event| Value::Object(event.fields.clone()))
            .collect();
        assert_eq!(requests.len(), 1);
        assert!(
            *lock(&changed) >= 2,
            "registered and settled reached the page listener"
        );
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_running_session_gets_the_notice_injected_and_its_turn_answers_it() {
        let fixture = fixture("inject", true);
        let plugin = start(&fixture, json!({}));
        let handle = session(&fixture);
        // The first step holds the turn in a tool call while the job settles, so the notice is injected.
        std::fs::write(
            &fixture.script,
            r#"{"steps":[{"toolCall":{"name":"bash","arguments":{"command":"sleep 1"}}},{"text":"done"}]}"#,
        )
        .unwrap();
        let runtime = Arc::clone(&fixture.runtime);
        let turn_handle = handle.clone();
        let turn = tokio::spawn(async move {
            heddle_agent::run_turn(
                &runtime,
                RunTurnOptions::new(turn_handle, "scripted", "work on it"),
            )
            .await
        });
        until("the turn to call the model", || {
            events(&fixture, &handle)
                .iter()
                .any(|event| event.kind == "model/request")
        })
        .await;
        let (spec, producer) = manual_spec(Some(&handle.id), "make build", None);
        plugin.registry.start(spec).unwrap();
        producer.finish(JobOutcome::new(
            OutcomeStatus::Completed,
            Some("exit code: 0"),
        ));
        until("the notice to be injected", || {
            events(&fixture, &handle)
                .iter()
                .any(|event| event.kind == heddle_session::inbox::INBOX_SPLICED)
        })
        .await;
        turn.await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let users = user_messages(&fixture, &handle);
        assert_eq!(
            users
                .iter()
                .map(|message| message["source"]["kind"].clone())
                .collect::<Vec<_>>(),
            [Value::Null, json!("tool-jobs")],
            "the person's prompt, then the claimed notice"
        );
        assert_eq!(
            events(&fixture, &handle)
                .iter()
                .filter(|event| event.kind == "turn/completed")
                .count(),
            1,
            "the running turn answered it; no wake turn"
        );
        plugin.dispose();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disposing_the_row_tears_jobs_down_with_no_notice() {
        let fixture = fixture("teardown", false);
        let plugin = start(&fixture, json!({}));
        let handle = session(&fixture);
        let (spec, producer) = manual_spec(
            Some(&handle.id),
            "sleep 30",
            Some(JobOutcome::new(
                OutcomeStatus::Killed,
                Some("signal: SIGTERM"),
            )),
        );
        plugin.registry.start(spec).unwrap();
        drop(JobsTeardown(Arc::clone(&plugin)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            producer.cancels(),
            [Some("jobs service disposed".to_owned())]
        );
        assert!(user_messages(&fixture, &handle).is_empty());
        let settled = settled_in_log(&fixture, &handle, &plugin_job(&fixture, &handle)).await;
        assert_eq!(settled["cause"], "teardown");
        let refused = plugin
            .registry
            .start(manual_spec(None, "x", None).0)
            .unwrap_err();
        assert_eq!(refused.code, "JOB_DISPOSED");
    }

    fn plugin_job(fixture: &Fixture, handle: &SessionHandle) -> String {
        events(fixture, handle)
            .iter()
            .find(|event| event.kind == "job/registered")
            .and_then(|event| {
                event
                    .get("jobId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap()
    }

    #[test]
    fn a_bad_config_fails_the_row_naming_the_field() {
        assert!(whole("retainBytes", Some(1.5), 1.0).is_err());
        assert_eq!(whole("retainBytes", Some(8.0), 1.0), Ok(Some(8)));
        assert!(at_least("killGraceMs", Some(-1.0), 0.0).is_err());
    }
}
