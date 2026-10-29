//! The `schedule` row composed over the crates that own each capability (`src/plugins/schedule.ts`): what the
//! binary calls, with one line, when a profile loads the row.
//!
//! | Seam | Over |
//! |---|---|
//! | the store file | `config.file`, else `<heddle home>/schedule.json` |
//! | delegated children | the session's metadata (`delegationDepth > 0`) in `heddle-session`'s store |
//! | the four tools | `heddle-tools`' registry, each an async `tool_fn` |
//! | a reminder's turn | `heddle-agent`'s [`begin_turn`](heddle_agent::begin_turn) on the run's shared runtime: the user message is in the session's log and the turn is live before it returns |
//! | busy and idle | `heddle-agent`'s `TurnRegistry` when the profile loads `turns`; else the session's own turn events, forwarded to [`SchedulePlugin::on_session_event`] |
//! | the delivery proof | the user message, found in the session's own log |
//!
//! Delivery is **off until the host starts it** (`autoStart`, default false): `heddle web` calls
//! [`SchedulePlugin::start_delivery`] after its goal and team sweeps, so a one-shot command that loads the row never
//! starts turns for sessions it is not working on.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use futures::future::BoxFuture;
use heddle_agent::{AgentRuntime, RoundLimit, RunTurnOptions};
use heddle_session::{SessionService, SessionStore};
use heddle_tools::{ToolRegistry, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use crate::delivery::{DeliveryHost, DriverOptions, ScheduleDriver};
use crate::service::{SUBAGENT_TARGET_MESSAGE, ScheduleService, ScheduleServiceOptions, Warn};
use crate::store::default_schedule_file;
use crate::tool::{ScheduleTools, schedule_tool_specs};

/// The row's `config` (`src/plugins/schedule.ts`'s schema).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfig {
    /// The store file; `<heddle home>/schedule.json` when absent.
    #[serde(default)]
    pub file: Option<String>,
    /// Days of delivery history each task keeps, 1-3650 (default 30).
    #[serde(default)]
    pub delivery_history_days: Option<f64>,
    /// Delivery records each task keeps, 1-10000 (default 200).
    #[serde(default)]
    pub delivery_history_records: Option<f64>,
    /// Start delivering as soon as the row loads. Off by default.
    #[serde(default)]
    pub auto_start: Option<bool>,
    /// The round cap of a reminder's turn; the loop's own default when absent.
    #[serde(default)]
    pub max_rounds: Option<f64>,
}

/// What the `schedule` row is started from.
pub struct ScheduleRow<'a> {
    /// The row's `config`; `{}` takes the defaults.
    pub config: &'a Value,
    /// The `session` service.
    pub sessions: Arc<SessionService>,
    /// The run's shared runtime; the row keeps only a weak reference, because the runtime's registry holds the
    /// row's tools, which hold the service.
    pub runtime: Arc<AgentRuntime>,
    /// `$HEDDLE_HOME`, where the default store file lives.
    pub heddle_home: PathBuf,
    /// The home directory a `~` in `config.file` names.
    pub home: PathBuf,
    /// Where drives, timers and reminder turns run; the caller's runtime when absent.
    pub async_runtime: Option<tokio::runtime::Handle>,
    /// Where a contained failure is reported (the TypeScript build logs at warn).
    pub warn: Option<Warn>,
}

/// The started row: the service, its driver and the host they deliver through.
pub struct SchedulePlugin {
    /// `ctx.schedule`.
    pub service: Arc<ScheduleService>,
    /// The delivery driver.
    pub driver: Arc<ScheduleDriver>,
    host: Arc<RuntimeHost>,
}

impl SchedulePlugin {
    /// Start delivery — what `heddle web` calls after its boot sweeps.
    pub fn start_delivery(&self) {
        self.driver.start();
    }

    /// A session event's type, as the bus carries it (`session/event`). Without a live-turn registry the turn
    /// events stand in for "busy", and a turn's end is the edge a waiting reminder needs.
    pub fn on_session_event(&self, session: &str, kind: &str) {
        if self.host.registry().is_some() {
            return;
        }
        let mut in_turn = self.host.in_turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match kind {
            "turn/completed" | "turn/failed" => {
                in_turn.remove(session);
                drop(in_turn);
                self.driver.turn_ended(session);
            }
            "model/request" | "assistant/chunk" | "turn/retry" | "tool/result" => {
                in_turn.insert(session.to_owned());
            }
            _ => {}
        }
    }
}

fn integer(value: Option<f64>) -> Option<i64> {
    value.map(|number| if number.fract() == 0.0 { number as i64 } else { 0 })
}

fn expand_home(path: &str, home: &std::path::Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

fn delegation_depth(store: &SessionStore, session: &str) -> u64 {
    store
        .meta(session)
        .and_then(|meta| meta.delegation_depth())
        .unwrap_or(0)
}

/// Start the `schedule` row: open the store (a corrupt file fails the row), register the four tools with the
/// runtime's registry, and build the driver. `Err` is the sentence the boot reports for a failed row.
pub fn start_row(row: ScheduleRow<'_>) -> Result<Arc<SchedulePlugin>, String> {
    let config: ScheduleConfig =
        serde_json::from_value(row.config.clone()).map_err(|error| format!("schedule: {error}"))?;
    let store = Arc::clone(row.sessions.store());
    let file = config
        .file
        .as_deref()
        .map(|file| expand_home(file, &row.home))
        .unwrap_or_else(|| default_schedule_file(&row.heddle_home));
    let warn: Warn = row
        .warn
        .unwrap_or_else(|| Arc::new(|message: &str| tracing::warn!("{message}")));
    let mut options = ScheduleServiceOptions::new(file);
    options.retention_days = integer(config.delivery_history_days);
    options.retention_records = integer(config.delivery_history_records);
    let delegated = Arc::clone(&store);
    options.is_delegated = Some(Arc::new(move |session: &str| delegation_depth(&delegated, session) > 0));
    options.warn = Some(Arc::clone(&warn));
    let service = Arc::new(ScheduleService::new(options).map_err(|error| error.to_string())?);

    let depths = Arc::clone(&store);
    let tools = ScheduleTools::new(
        Arc::clone(&service),
        Arc::new(move |session: &str| delegation_depth(&depths, session)),
    );
    register_tools(&row.runtime.tools, &tools)?;

    let async_runtime = row
        .async_runtime
        .or_else(|| tokio::runtime::Handle::try_current().ok());
    let host = Arc::new(RuntimeHost {
        runtime: Arc::downgrade(&row.runtime),
        store,
        max_rounds: config
            .max_rounds
            .filter(|rounds| rounds.is_finite() && *rounds >= 0.0)
            .map(|rounds| rounds.min(f64::from(u32::MAX)) as u32),
        async_runtime: async_runtime.clone(),
        warn: Arc::clone(&warn),
        driver: OnceLock::new(),
        in_turn: Mutex::new(HashSet::new()),
    });
    let driver = ScheduleDriver::new(
        Arc::clone(&service),
        host.clone(),
        DriverOptions {
            timers: None,
            busy_recheck_ms: None,
            warn: Some(warn),
            runtime: async_runtime,
        },
    );
    let _ = host.driver.set(Arc::downgrade(&driver));
    let plugin = Arc::new(SchedulePlugin {
        service,
        driver,
        host,
    });
    if config.auto_start == Some(true) {
        plugin.start_delivery();
    }
    Ok(plugin)
}

/// Register the four tools with a registry, each running [`ScheduleTools::call`] for the calling session.
pub fn register_tools(registry: &ToolRegistry, tools: &ScheduleTools) -> Result<(), String> {
    for spec in schedule_tool_specs() {
        let name = spec.name.clone();
        let tools = tools.clone();
        let tool = heddle_tools::tool_fn(spec, move |args, context| {
            let tools = tools.clone();
            let name = name.clone();
            let session = context.context().session.as_ref().map(|handle| handle.id.clone());
            let cancel = context.context().cancel.clone();
            Box::pin(async move {
                let result: ToolResult = tools
                    .call(&name, &Value::Object(args), session.as_deref(), cancel)
                    .await;
                Ok(result)
            })
        });
        registry
            .register(tool)
            .map_err(|error| format!("schedule: {error}"))?;
    }
    Ok(())
}

/// [`DeliveryHost`] over the session store and the shared runtime.
struct RuntimeHost {
    runtime: Weak<AgentRuntime>,
    store: Arc<SessionStore>,
    max_rounds: Option<u32>,
    async_runtime: Option<tokio::runtime::Handle>,
    warn: Warn,
    driver: OnceLock<Weak<ScheduleDriver>>,
    /// Sessions whose turn events say a turn is in flight, for a profile without a live-turn registry.
    in_turn: Mutex<HashSet<String>>,
}

impl RuntimeHost {
    fn registry(&self) -> Option<heddle_agent::TurnRegistry> {
        self.runtime.upgrade().and_then(|runtime| runtime.turns.clone())
    }

    fn begin(&self, session_id: &str, text: &str, source: Value) -> Result<(), String> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or("the run that owned this schedule has ended")?;
        let spawner = self
            .async_runtime
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
            .ok_or("no async runtime is running to start a reminder turn")?;
        let handle = self
            .store
            .open(session_id)
            .ok_or_else(|| format!("session \"{session_id}\" is not available"))?;
        let meta = self.store.meta(session_id);
        let endpoint = meta
            .as_ref()
            .and_then(|meta| meta.endpoint().map(str::to_owned))
            .or_else(|| runtime.model.default_endpoint())
            .ok_or("no endpoint is configured for a reminder turn")?;
        let mut options = RunTurnOptions::new(handle, endpoint, text);
        options.source = Some(source);
        options.model = meta.as_ref().and_then(|meta| meta.model().map(str::to_owned));
        options.reasoning_effort = meta
            .as_ref()
            .and_then(|meta| meta.reasoning_effort().map(str::to_owned));
        if let Some(rounds) = self.max_rounds {
            options.max_rounds = RoundLimit::Rounds(rounds);
        }
        // Started, not awaited: the user message and the live registration are durable when begin returns, which
        // is all delivery needs, and a drive must not hold the schedule queue for the length of a model call.
        let begun = heddle_agent::begin_turn(&runtime, options).map_err(|error| error.to_string())?;
        let warn = Arc::clone(&self.warn);
        let driver = self.driver.get().cloned();
        let session = session_id.to_owned();
        spawner.spawn(async move {
            if let Err(error) = begun.run().await {
                warn(&format!(
                    "schedule: the reminder turn in session {session} failed — {error}"
                ));
                if let Some(driver) = driver.and_then(|driver| driver.upgrade()) {
                    driver.turn_ended(&session);
                }
            }
        });
        Ok(())
    }
}

impl DeliveryHost for RuntimeHost {
    fn resolve(&self, session_id: &str) -> Result<(), String> {
        if self.store.open(session_id).is_none() {
            return Err(format!("session \"{session_id}\" is not available"));
        }
        if delegation_depth(&self.store, session_id) > 0 {
            return Err(SUBAGENT_TARGET_MESSAGE.to_owned());
        }
        Ok(())
    }

    fn is_busy(&self, session_id: &str) -> bool {
        match self.registry() {
            Some(turns) => turns.is_running(session_id),
            None => self
                .in_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(session_id),
        }
    }

    fn cursor(&self, session_id: &str) -> usize {
        self.store
            .open(session_id)
            .and_then(|handle| self.store.count(&handle).ok())
            .map_or(0, |count| count as usize)
    }

    fn start_turn(&self, session_id: &str, text: &str, source: Value) -> BoxFuture<'static, Result<(), String>> {
        let started = self.begin(session_id, text, source);
        Box::pin(async move { started })
    }

    fn find(&self, session_id: &str, cursor: usize, text: &str) -> Option<String> {
        let handle = self.store.open(session_id)?;
        let events = self.store.read(&handle).ok()?;
        for event in events.iter().skip(cursor) {
            if event.kind != "message" {
                continue;
            }
            let Some(message) = event.get("message") else {
                continue;
            };
            let from_schedule = message.get("role").and_then(Value::as_str) == Some("user")
                && message
                    .get("source")
                    .and_then(|source| source.get("kind"))
                    .and_then(Value::as_str)
                    == Some("schedule");
            if !from_schedule {
                continue;
            }
            let body: String = message
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|part| {
                    if part.get("type").and_then(Value::as_str) == Some("text") {
                        part.get("text").and_then(Value::as_str).unwrap_or("")
                    } else {
                        ""
                    }
                })
                .collect();
            if body != text {
                continue;
            }
            let id = event
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| message.get("id").and_then(Value::as_str))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("message-{}", uuid::Uuid::new_v4()));
            return Some(id);
        }
        None
    }

    fn when_idle(&self, session_id: &str) -> Option<BoxFuture<'static, ()>> {
        let turns = self.registry()?;
        let session = session_id.to_owned();
        Some(Box::pin(async move { turns.when_idle(&session).await }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::render_reminder_framing;
    use crate::rules::create_after_schedule_record;
    use crate::store::ScheduleTask;
    use heddle_agent::{ContextPort, LlmModel, PortError};
    use heddle_config::Env;
    use heddle_session::{CreateOptions, SessionConfig, SessionHandle};
    use serde_json::json;

    struct PromptOnly;

    fn report() -> heddle_agent::upstream::ContextReport {
        heddle_agent::upstream::ContextReport {
            messages: vec![heddle_llm::Message::new(
                heddle_llm::Role::User,
                vec![heddle_llm::ContentPart::Text { text: "continue".into() }],
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

    struct Fixture {
        root: PathBuf,
        sessions: Arc<SessionService>,
        runtime: Arc<AgentRuntime>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture(label: &str, turns: bool) -> Fixture {
        let root = crate::store::tests::scratch(&format!("compose-{label}"));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let script = root.join("scripted.json");
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
            serde_json::from_value(json!({"root": root.join("sessions").display().to_string()})).unwrap();
        let sessions = Arc::new(SessionService::new(&config, &Env::default(), None));
        let sandbox_config: heddle_sandbox::SandboxConfig = serde_json::from_value(json!({
            "mode": "workspace-write",
            "workspaceRoot": work.display().to_string(),
            "backend": "none"
        }))
        .unwrap();
        let host = heddle_sandbox::SandboxHost::detect(root.join("home")).unwrap();
        let sandbox = Arc::new(heddle_sandbox::SandboxService::new(&sandbox_config, &host));
        let approvals: heddle_sandbox::ApprovalsConfig = serde_json::from_value(json!({"mode": "allow"})).unwrap();
        let gates = heddle_tools::ToolGates {
            approvals: Arc::new(heddle_tools::adapters::SandboxApprovals::new(Arc::new(
                heddle_sandbox::ApprovalService::new(approvals),
            ))),
            sandbox: Arc::new(heddle_tools::adapters::Sandbox::new(sandbox)),
            modes: Arc::new(heddle_tools::DefaultModes),
            hooks: Arc::new(heddle_tools::NoToolHooks),
        };
        let runtime = Arc::new(AgentRuntime {
            model: Arc::new(LlmModel::new(model)),
            session: Arc::new(heddle_agent::adapters::Sessions::new(sessions.clone())),
            context: Arc::new(PromptOnly),
            tools: Arc::new(ToolRegistry::new(gates)),
            hooks: Arc::new(heddle_agent::NoTurnHooks),
            turns: turns.then(heddle_agent::TurnRegistry::new),
        });
        Fixture { root, sessions, runtime }
    }

    fn start(fixture: &Fixture, config: Value) -> Result<Arc<SchedulePlugin>, String> {
        start_row(ScheduleRow {
            config: &config,
            sessions: Arc::clone(&fixture.sessions),
            runtime: Arc::clone(&fixture.runtime),
            heddle_home: fixture.root.join("home"),
            home: fixture.root.join("home"),
            async_runtime: None,
            warn: None,
        })
    }

    fn session(fixture: &Fixture) -> String {
        fixture
            .sessions
            .store()
            .create(CreateOptions {
                cwd: Some(fixture.root.join("work").display().to_string()),
                endpoint: Some("scripted".into()),
                ..CreateOptions::default()
            })
            .unwrap()
            .id
    }

    fn user_messages(fixture: &Fixture, session: &str) -> Vec<Value> {
        let store = fixture.sessions.store();
        let handle = store.open(session).unwrap();
        store
            .read(&handle)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "message")
            .filter_map(|event| event.get("message").cloned())
            .filter(|message| message["role"] == "user")
            .collect()
    }

    async fn until(what: &str, condition: impl Fn() -> bool) {
        for _ in 0..300 {
            if condition() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_row_registers_the_four_tools_and_delivers_a_due_reminder_into_the_real_session_log() {
        let fixture = fixture("deliver", true);
        let plugin = start(&fixture, json!({})).unwrap();
        let names: Vec<String> = fixture.runtime.tools.describe().iter().map(|spec| spec.name.clone()).collect();
        for name in ["schedule_create", "schedule_list", "schedule_delete", "schedule_update"] {
            assert!(names.contains(&name.to_owned()), "{name} in {names:?}");
        }
        let session = session(&fixture);
        let record = create_after_schedule_record("schedule-due", &json!("check the build"), &json!(30), now() - 60_000, &json!("Build")).unwrap();
        plugin.service.store().put(&record.id, ScheduleTask::new(session.clone(), record.clone())).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(user_messages(&fixture, &session).is_empty(), "nothing is delivered until the host starts delivery");
        plugin.start_delivery();
        until("the delivery to commit", || plugin.service.tasks()[0].status == crate::store::TaskStatus::Inactive).await;
        let messages = user_messages(&fixture, &session);
        assert_eq!(messages[0]["source"], json!({"kind": "schedule"}));
        assert_eq!(messages[0]["content"][0]["text"], json!(render_reminder_framing(&record)));
        let message_id = plugin.service.tasks()[0].last_delivery.clone().unwrap().message_id;
        assert!(message_id.starts_with("message-") && message_id.len() == "message-".len() + 36, "{message_id}");
        let store = fixture.sessions.store();
        until("the reminder turn to complete", || {
            store.read(&store.open(&session).unwrap()).unwrap().iter().any(|event| event.kind == "turn/completed")
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_row_waits_for_a_running_turn_to_complete_before_it_starts_the_reminder_turn() {
        let fixture = fixture("busy", true);
        let plugin = start(&fixture, json!({})).unwrap();
        let session = session(&fixture);
        let record = create_after_schedule_record("schedule-due", &json!("after the turn"), &json!(30), now() - 60_000, &json!("Later")).unwrap();
        plugin.service.store().put(&record.id, ScheduleTask::new(session.clone(), record.clone())).unwrap();
        let running = fixture.runtime.turns.as_ref().unwrap().begin(&session, None);
        plugin.start_delivery();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(user_messages(&fixture, &session).is_empty(), "nothing is written while the turn runs");
        assert_eq!(plugin.service.tasks()[0].status, crate::store::TaskStatus::Active);
        running.settle();
        until("the delivery after the turn completed", || plugin.service.tasks()[0].status == crate::store::TaskStatus::Inactive).await;
        assert_eq!(user_messages(&fixture, &session)[0]["content"][0]["text"], json!(render_reminder_framing(&record)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_corrupt_store_file_fails_the_row_instead_of_running_without_reminders() {
        let fixture = fixture("corrupt", true);
        let file = fixture.root.join("home").join("schedule.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"unit":{"name":"schedule","version":1},"global":null,"tables":{"tasks":{"x":{}}}}"#).unwrap();
        let error = start(&fixture, json!({})).err().unwrap();
        assert!(error.contains("is not a valid schedule store"), "{error}");
    }
}
