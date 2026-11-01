//! The background-job substrate: DSH's `ctx.jobs` (`dsh-jobs` contract, `dsh-jobs-local` provider), in memory.
//!
//! A port of `src/jobs/registry.ts`. A producer — background `bash` today, anything with a non-empty kind later —
//! registers work with [`JobRegistry::start`], gets a [`JobHandle`] to append output and progress through, and hands
//! back a cancel and a `done` future. The registry owns the job's state, its bounded output ring, the model's read
//! cursor, ownership, and the lifecycle facts other layers react to (the completion notice, the page's job list).
//! Jobs live in memory, die with the process, and are not resumed, as in DSH.
//!
//! Every mutation and the events it causes run under one ordering gate, so listeners see events in the order the
//! TypeScript build's single thread would emit them; a listener (or a producer's cancel) that calls back into the
//! registry on the same thread passes the gate it already holds. Citations are `LOCAL:n` for
//! `dsh-jobs-local/lib/index.js`.

use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use heddle_tools::CancellationToken;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::{oneshot, watch};

use crate::js::{is_safe_integer, json_number};
use crate::ring::{AppendOptions, JobChannel, JobChunk, OutputRing, RingRead};

/// The stable refusal codes, beside DSH's sentences (listed in the crate's `INDEX.md`).
pub mod codes {
    /// No job has the id.
    pub const JOB_UNKNOWN: &str = "JOB_UNKNOWN";
    /// The job belongs to another session.
    pub const JOB_FOREIGN: &str = "JOB_FOREIGN";
    /// An empty `job_id`, a bad wait timeout or read offset, an empty kind or label, a bad `outputLimitBytes`.
    pub const JOB_INVALID_ARGS: &str = "JOB_INVALID_ARGS";
    /// The owner session does not exist, or no session store is reachable.
    pub const JOB_OWNER_UNAVAILABLE: &str = "JOB_OWNER_UNAVAILABLE";
    /// No controller serves the registry, or `bash` was asked for the background with no jobs row loaded.
    pub const JOB_UNAVAILABLE: &str = "JOB_UNAVAILABLE";
    /// The owner already holds the cap of running and stopping jobs.
    pub const JOB_LIMIT: &str = "JOB_LIMIT";
    /// The turn was stopped during `job_output`'s wait.
    pub const JOB_WAIT_ABORTED: &str = "JOB_WAIT_ABORTED";
    /// `remove` on a job that has not settled.
    pub const JOB_LIVE: &str = "JOB_LIVE";
    /// A start after the registry was disposed.
    pub const JOB_DISPOSED: &str = "JOB_DISPOSED";
    /// Not a refusal: a producer's cancel failed (the TypeScript build's thrown `Error`). A tool answers it as
    /// `TOOL_FAILED`, a route as `500`.
    pub const JOB_CANCEL_FAILED: &str = "JOB_CANCEL_FAILED";
}

/// DSH's defaults (LOCAL:339-346).
pub const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER: usize = 10;
pub const DEFAULT_RETAIN_BYTES: u64 = 256 * 1024;
pub const DEFAULT_SETTLED_RETAIN_BYTES: u64 = 16 * 1024;
pub const DEFAULT_PUMP_POLL_MS: u64 = 150;

/// DSH's five statuses. Registration sets `running`; a kill or a teardown sets `stopping`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Stopping,
    Completed,
    Killed,
    Failed,
}

impl JobStatus {
    /// The status as DSH spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Completed => "completed",
            Self::Killed => "killed",
            Self::Failed => "failed",
        }
    }

    /// True for the three terminal statuses.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Killed | Self::Failed)
    }
}

/// What ended a job: its producer, a kill, or a teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SettleCause {
    Producer,
    Kill,
    Teardown,
}

impl SettleCause {
    /// The cause as DSH spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Producer => "producer",
            Self::Kill => "kill",
            Self::Teardown => "teardown",
        }
    }
}

/// The tool call that started a job: heddle has no programmatic sub-calls, so both ids are the model's call id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobToolCall {
    pub call_id: String,
    pub root_call_id: String,
}

/// A view's output offsets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutput {
    pub total: u64,
    pub earliest: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spill_paths: Option<Vec<String>>,
}

/// A fresh read-only projection of one job, serialized with the TypeScript build's keys and order. There is no
/// exit-code field; it lives in `detail`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub kind: String,
    pub label: String,
    /// The owning session's id; absent for an unowned job, which every caller may reach.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_limit_bytes: Option<u64>,
    pub status: JobStatus,
    /// The live progress line; cleared at settle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    /// The terminal reason, with any kill reason merged in as `<detail>; <reason>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub output: JobOutput,
}

/// A producer's terminal status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeStatus {
    Completed,
    Killed,
    Failed,
}

impl From<OutcomeStatus> for JobStatus {
    fn from(status: OutcomeStatus) -> Self {
        match status {
            OutcomeStatus::Completed => JobStatus::Completed,
            OutcomeStatus::Killed => JobStatus::Killed,
            OutcomeStatus::Failed => JobStatus::Failed,
        }
    }
}

/// A producer's terminal report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobOutcome {
    pub status: OutcomeStatus,
    pub detail: Option<String>,
    /// A final-output job's result, handed to the first consuming read after settle.
    pub result: Option<String>,
}

impl JobOutcome {
    /// An outcome with this status and detail.
    pub fn new(status: OutcomeStatus, detail: Option<&str>) -> Self {
        Self {
            status,
            detail: detail.map(str::to_owned),
            result: None,
        }
    }

    /// `failed` with a detail.
    pub fn failed(detail: impl Into<String>) -> Self {
        Self {
            status: OutcomeStatus::Failed,
            detail: Some(detail.into()),
            result: None,
        }
    }
}

/// A producer's synchronous, idempotent cancel; `Err` is a cancel that failed (the TypeScript `throw`).
pub type CancelFn = Box<dyn Fn(Option<&str>) -> Result<(), String> + Send + Sync>;

/// What `run` hands back: the cancel, and the end of the work. `done` must resolve; a panic in it is a contract
/// violation reported and settled `failed`.
pub struct JobHooks {
    pub cancel: CancelFn,
    pub done: BoxFuture<'static, JobOutcome>,
}

/// One pull read: the text from `from_byte`, the next offset, and whether bytes before it were lost.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PullRead {
    pub text: String,
    pub next_offset: u64,
    pub lossy: bool,
    pub spill_path: Option<String>,
}

/// A stream the registry drains on its own clock instead of the producer pushing (DSH's pull sources).
pub trait PullSource: Send + 'static {
    /// The channel its chunks are labelled with.
    fn channel(&self) -> Option<JobChannel> {
        None
    }
    /// Read from an offset; `Err` stops the stream (reported once).
    fn read(&mut self, from_byte: u64) -> Result<PullRead, String>;
}

/// A producer's registration.
pub struct JobSpec {
    pub kind: String,
    pub label: String,
    /// The owning session's id. It must exist in the session store.
    pub owner: Option<String>,
    pub tool_call: Option<JobToolCall>,
    pub output_limit_bytes: Option<f64>,
    /// Streams drained every `pump_poll_ms`, then once more before the job settles.
    pub output: Vec<Box<dyn PullSource>>,
    pub run: Box<dyn FnOnce(JobHandle) -> JobHooks + Send>,
}

impl JobSpec {
    /// A spec of this kind and label, unowned, with no pull sources.
    pub fn new(
        kind: impl Into<String>,
        label: impl Into<String>,
        run: impl FnOnce(JobHandle) -> JobHooks + Send + 'static,
    ) -> Self {
        Self {
            kind: kind.into(),
            label: label.into(),
            owner: None,
            tool_call: None,
            output_limit_bytes: None,
            output: Vec::new(),
            run: Box::new(run),
        }
    }

    /// The same spec, owned by a session.
    pub fn owned_by(mut self, owner: impl Into<String>) -> Self {
        self.owner = Some(owner.into());
        self
    }
}

/// The consuming read: the delta since the model's cursor, the result once, and the job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRead {
    pub chunks: Vec<JobChunk>,
    pub lossy: bool,
    pub result: Option<String>,
    pub job: JobView,
}

/// What a kill answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum KillOutcome {
    #[serde(rename = "requested")]
    Requested,
    #[serde(rename = "already-finished")]
    AlreadyFinished,
}

impl KillOutcome {
    /// DSH's spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::AlreadyFinished => "already-finished",
        }
    }
}

/// The in-memory event stream: lifecycle changes and output advances, for notices and the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobEvent {
    Registered {
        job: JobView,
    },
    Progress {
        job: JobView,
    },
    Stopping {
        job: JobView,
    },
    Settled {
        job: JobView,
        cause: SettleCause,
        awaited: bool,
    },
    Removed {
        job: JobView,
    },
    Output {
        id: String,
        owner: Option<String>,
        total: u64,
    },
}

impl JobEvent {
    /// The event's type, as the TypeScript union spells it.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Registered { .. } => "registered",
            Self::Progress { .. } => "progress",
            Self::Stopping { .. } => "stopping",
            Self::Settled { .. } => "settled",
            Self::Removed { .. } => "removed",
            Self::Output { .. } => "output",
        }
    }

    /// The job a lifecycle event carries; `None` for `output`.
    pub fn job(&self) -> Option<&JobView> {
        match self {
            Self::Registered { job }
            | Self::Progress { job }
            | Self::Stopping { job }
            | Self::Settled { job, .. }
            | Self::Removed { job } => Some(job),
            Self::Output { .. } => None,
        }
    }
}

/// A refusal with a stable code beside DSH's message: the message is DSH's text, adapted only where it names a DSH
/// package; the code is heddle's, so a tool result and a route carry heddle's `{code, message}` shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

impl JobError {
    /// A refusal with this code and sentence.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for JobError {}

/// Where a contained failure is reported.
pub type Warn = Arc<dyn Fn(&str) + Send + Sync>;
/// Whether a session id names a session that exists.
pub type SessionExists = Arc<dyn Fn(&str) -> bool + Send + Sync>;
/// Append one lifecycle event (`job/registered`, `job/settled`) to an owned job's session log.
pub type RecordEvent =
    Arc<dyn Fn(&str, &str, Map<String, Value>) -> Result<(), String> + Send + Sync>;
/// One event listener.
pub type Listener = Arc<dyn Fn(&JobEvent) + Send + Sync>;

/// The facts the registry needs from its host, so it can be tested without a composition.
#[derive(Clone, Default)]
pub struct JobRegistryOptions {
    /// Absent means no session store is reachable, and an owned registration is refused.
    pub session_exists: Option<SessionExists>,
    /// A failure is reported and swallowed (LOCAL:616-624).
    pub record: Option<RecordEvent>,
    pub warn: Option<Warn>,
    /// Active (running + stopping) jobs one owner may hold; DSH's default is 10.
    pub max_concurrent_jobs_per_owner: Option<usize>,
    /// Live ring retention per job, in UTF-8 bytes; DSH's default is 262144.
    pub retain_bytes: Option<u64>,
    /// Ring retention kept after settlement, in UTF-8 bytes; DSH's default is 16384.
    pub settled_retain_bytes: Option<u64>,
    /// Pull-source poll interval; DSH's default is 150 ms.
    pub pump_poll_ms: Option<u64>,
    /// The hex randomness an id is cut from; a test replaces it to force a collision.
    pub random_hex: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    /// Where settles, pumps and waits run; the caller's runtime when absent.
    pub runtime: Option<tokio::runtime::Handle>,
}

struct JobRecord {
    id: String,
    kind: String,
    label: String,
    owner: Option<String>,
    tool_call: Option<JobToolCall>,
    output_limit_bytes: Option<u64>,
    /// `None` until registration commits (while the producer's `run` is building it).
    cancel: Option<Arc<CancelFn>>,
    committed: bool,
    ring: OutputRing,
    progress: Option<String>,
    status: JobStatus,
    model_cursor: u64,
    result_delivered: bool,
    detail: Option<String>,
    result: Option<String>,
    started_at: u64,
    finished_at: Option<u64>,
    kill_reason: Option<String>,
    settle_cause: Option<SettleCause>,
    settled: watch::Sender<bool>,
    waiters: Vec<(u64, oneshot::Sender<JobView>)>,
    spill_paths: Vec<Option<String>>,
}

#[derive(Default)]
struct State {
    jobs: Vec<JobRecord>,
    controllers: usize,
    disposed: bool,
    next_token: u64,
}

impl State {
    fn find(&self, id: &str) -> Option<&JobRecord> {
        self.jobs.iter().find(|job| job.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut JobRecord> {
        self.jobs.iter_mut().find(|job| job.id == id)
    }

    /// A committed job the caller may reach (LOCAL:564-577).
    fn expect(&mut self, id: &str, caller: Option<&str>) -> Result<&mut JobRecord, JobError> {
        let Some(job) = self.find_mut(id).filter(|job| job.committed) else {
            return Err(JobError::new(
                codes::JOB_UNKNOWN,
                format!("unknown job {id}"),
            ));
        };
        if job.owner.is_some() && job.owner.as_deref() != caller {
            return Err(JobError::new(
                codes::JOB_FOREIGN,
                format!("job {} belongs to another session", job.id),
            ));
        }
        Ok(job)
    }

    fn token(&mut self) -> u64 {
        self.next_token += 1;
        self.next_token
    }
}

enum Effect {
    Record {
        owner: String,
        id: String,
        kind: &'static str,
        data: Map<String, Value>,
    },
    Event(JobEvent),
    Release(Vec<oneshot::Sender<JobView>>, JobView),
    Warn(String),
}

thread_local! {
    /// The registries whose ordering gate this thread holds, so a re-entrant call passes it.
    static HELD: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

struct Gate<'a> {
    guard: Option<MutexGuard<'a, ()>>,
    key: usize,
}

impl Drop for Gate<'_> {
    fn drop(&mut self) {
        if self.guard.is_some() {
            HELD.with(|held| {
                let mut held = held.borrow_mut();
                if let Some(index) = held.iter().rposition(|key| *key == self.key) {
                    held.remove(index);
                }
            });
        }
    }
}

struct Shared {
    session_exists: Option<SessionExists>,
    record: Option<RecordEvent>,
    warn: Option<Warn>,
    max_concurrent_jobs_per_owner: usize,
    retain_bytes: u64,
    settled_retain_bytes: u64,
    pump_poll_ms: u64,
    random_hex: Arc<dyn Fn() -> String + Send + Sync>,
    runtime: Option<tokio::runtime::Handle>,
    state: Mutex<State>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    gate: Mutex<()>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn view(job: &JobRecord) -> JobView {
    let mut spill_paths: Vec<String> = Vec::new();
    for path in job.spill_paths.iter().flatten() {
        if !spill_paths.contains(path) {
            spill_paths.push(path.clone());
        }
    }
    JobView {
        id: job.id.clone(),
        kind: job.kind.clone(),
        label: job.label.clone(),
        owner: job.owner.clone(),
        output_limit_bytes: job.output_limit_bytes,
        status: job.status,
        progress: job.progress.clone(),
        detail: job.detail.clone(),
        started_at: job.started_at,
        finished_at: job.finished_at,
        output: JobOutput {
            total: job.ring.total,
            earliest: job.ring.earliest,
            spill_paths: (!spill_paths.is_empty()).then_some(spill_paths),
        },
    }
}

/// The fields both session-log events start with (LOCAL:604-625).
fn record_base(job: &JobRecord) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("jobId".into(), json!(job.id));
    data.insert("owner".into(), json!(job.owner));
    data.insert("kind".into(), json!(job.kind));
    data.insert("label".into(), json!(job.label));
    data.insert("startedAt".into(), json!(job.started_at));
    if let Some(call) = &job.tool_call {
        data.insert("toolCall".into(), json!(call));
    }
    data
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Writer {
    Producer,
    Pump,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn gate(&self) -> Gate<'_> {
        let key = self as *const Self as usize;
        if HELD.with(|held| held.borrow().contains(&key)) {
            return Gate { guard: None, key };
        }
        let guard = self
            .gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        HELD.with(|held| held.borrow_mut().push(key));
        Gate {
            guard: Some(guard),
            key,
        }
    }

    fn warn(&self, message: &str) {
        if let Some(warn) = &self.warn {
            warn(message);
        }
    }

    fn emit(&self, event: &JobEvent) {
        let listeners: Vec<Listener> = self
            .listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            if let Err(panic) = std::panic::catch_unwind(AssertUnwindSafe(|| listener(event))) {
                let reason = panic
                    .downcast_ref::<&str>()
                    .map(|text| (*text).to_owned())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "a panic".to_owned());
                self.warn(&format!(
                    "jobs: an event listener threw on {}: {reason}",
                    event.kind()
                ));
            }
        }
    }

    fn run_effects(&self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Record {
                    owner,
                    id,
                    kind,
                    data,
                } => {
                    if let Some(record) = &self.record
                        && let Err(error) = record(&owner, kind, data)
                    {
                        self.warn(&format!(
                            "jobs: failed to record lifecycle for {id}: {error}"
                        ));
                    }
                }
                Effect::Event(event) => self.emit(&event),
                Effect::Release(waiters, job) => {
                    for waiter in waiters {
                        let _ = waiter.send(job.clone());
                    }
                }
                Effect::Warn(message) => self.warn(&message),
            }
        }
    }

    fn record_effect(
        &self,
        job: &JobRecord,
        kind: &'static str,
        data: Map<String, Value>,
    ) -> Option<Effect> {
        let owner = job.owner.clone()?;
        self.record.as_ref()?;
        Some(Effect::Record {
            owner,
            id: job.id.clone(),
            kind,
            data,
        })
    }

    /// Append to the ring. A producer's chunk against a settled job is reported and dropped; the pump's is dropped
    /// silently. A chunk written inside `run`, before registration commits, is kept and signals nobody.
    fn append_ring(&self, id: &str, text: &str, options: AppendOptions, writer: Writer) {
        let _gate = self.gate();
        let effects = {
            let mut state = self.lock();
            let Some(job) = state.find_mut(id) else {
                return;
            };
            if job.status.is_terminal() {
                if writer == Writer::Producer {
                    vec![Effect::Warn(format!(
                        "jobs: append to settled job {id} dropped"
                    ))]
                } else {
                    Vec::new()
                }
            } else if !job.ring.append(text, options, self.retain_bytes) {
                Vec::new()
            } else if job.committed {
                vec![Effect::Event(JobEvent::Output {
                    id: job.id.clone(),
                    owner: job.owner.clone(),
                    total: job.ring.total,
                })]
            } else {
                Vec::new()
            }
        };
        self.run_effects(effects);
    }

    fn update_progress(&self, id: &str, line: &str) {
        let _gate = self.gate();
        let effects = {
            let mut state = self.lock();
            let Some(job) = state.find_mut(id) else {
                return;
            };
            if job.status.is_terminal() {
                vec![Effect::Warn(format!(
                    "jobs: progress update on settled job {id} dropped"
                ))]
            } else {
                job.progress = Some(line.to_owned());
                if job.committed {
                    vec![Effect::Event(JobEvent::Progress { job: view(job) })]
                } else {
                    Vec::new()
                }
            }
        };
        self.run_effects(effects);
    }

    fn set_spill(&self, id: &str, index: usize, path: Option<String>) {
        let mut state = self.lock();
        if let Some(job) = state.find_mut(id) {
            if job.spill_paths.len() <= index {
                job.spill_paths.resize(index + 1, None);
            }
            job.spill_paths[index] = path;
        }
    }

    /// Ask a job to stop: the producer's cancel runs first; if it fails, nothing changes. Otherwise the job is
    /// `stopping`, the reason is kept for the settle, and the cause is `kill` (LOCAL:644-655).
    fn kill_job(&self, id: &str, reason: Option<&str>) -> Result<KillOutcome, JobError> {
        let _gate = self.gate();
        let cancel = {
            let state = self.lock();
            let Some(job) = state.find(id) else {
                return Ok(KillOutcome::AlreadyFinished);
            };
            if job.status.is_terminal() {
                return Ok(KillOutcome::AlreadyFinished);
            }
            job.cancel.clone()
        };
        if let Some(cancel) = cancel {
            cancel(reason).map_err(|error| JobError::new(codes::JOB_CANCEL_FAILED, error))?;
        }
        let effects = {
            let mut state = self.lock();
            match state.find_mut(id) {
                Some(job) if !job.status.is_terminal() => {
                    job.status = JobStatus::Stopping;
                    if let Some(reason) = reason {
                        job.kill_reason = Some(reason.to_owned());
                    }
                    job.settle_cause = Some(SettleCause::Kill);
                    vec![Effect::Event(JobEvent::Stopping { job: view(job) })]
                }
                _ => Vec::new(),
            }
        };
        self.run_effects(effects);
        Ok(KillOutcome::Requested)
    }

    /// Record the first terminal outcome (LOCAL:769-796): first-wins; a kill reason merged into the detail; progress
    /// cleared and the finish time set; `job/settled` logged; the ring trimmed to what the model has not read (at
    /// least the settled cap); waiters released; then `settled`, carrying whether a waiter collected it.
    fn settle(
        &self,
        id: &str,
        outcome: JobOutcome,
        cause: Option<SettleCause>,
        producer_reported: bool,
    ) {
        let _gate = self.gate();
        let effects = {
            let mut state = self.lock();
            let Some(job) = state.find_mut(id) else {
                return;
            };
            if job.status.is_terminal() {
                return;
            }
            job.status = outcome.status.into();
            match (&job.kill_reason, outcome.status) {
                (Some(reason), OutcomeStatus::Killed) => {
                    job.detail = Some(match &outcome.detail {
                        Some(detail) => format!("{detail}; {reason}"),
                        None => reason.clone(),
                    });
                }
                _ => {
                    if let Some(detail) = &outcome.detail {
                        job.detail = Some(detail.clone());
                    }
                }
            }
            job.progress = None;
            job.result = outcome.result.clone();
            let finished_at = now_ms();
            job.finished_at = Some(finished_at);
            let cause = cause.or(job.settle_cause).unwrap_or(SettleCause::Producer);
            let mut effects = Vec::new();
            let mut data = record_base(job);
            data.insert("finishedAt".into(), json!(finished_at));
            data.insert("status".into(), json!(job.status.as_str()));
            data.insert("cause".into(), json!(cause.as_str()));
            data.insert("producerReported".into(), json!(producer_reported));
            if let Some(detail) = &job.detail {
                data.insert("detail".into(), json!(detail));
            }
            effects.extend(self.record_effect(job, "job/settled", data));
            let unread = job.ring.total - job.model_cursor.min(job.ring.total);
            job.ring.trim(self.settled_retain_bytes.max(unread));
            let waiters: Vec<oneshot::Sender<JobView>> =
                job.waiters.drain(..).map(|(_, waiter)| waiter).collect();
            let awaited = !waiters.is_empty();
            job.settled.send_replace(true);
            let settled = view(job);
            effects.push(Effect::Release(waiters, settled.clone()));
            effects.push(Effect::Event(JobEvent::Settled {
                job: settled,
                cause,
                awaited,
            }));
            effects.push(Effect::Event(JobEvent::Output {
                id: job.id.clone(),
                owner: job.owner.clone(),
                total: job.ring.total,
            }));
            effects
        };
        self.run_effects(effects);
    }

    fn drop_jobs(&self, ids: &[String]) {
        let _gate = self.gate();
        let effects = {
            let mut state = self.lock();
            let mut effects = Vec::new();
            for id in ids {
                if let Some(index) = state.jobs.iter().position(|job| &job.id == id) {
                    let job = state.jobs.remove(index);
                    effects.push(Effect::Event(JobEvent::Removed { job: view(&job) }));
                }
            }
            effects
        };
        self.run_effects(effects);
    }

    fn cancel_for_teardown(&self, ids: &[String], reason: &str) {
        for id in ids {
            let cancel = {
                let mut state = self.lock();
                let Some(job) = state.find_mut(id) else {
                    continue;
                };
                if job.status.is_terminal() {
                    continue;
                }
                job.settle_cause = Some(SettleCause::Teardown);
                job.cancel.clone()
            };
            let cancelled = cancel.map_or(Ok(()), |cancel| cancel(Some(reason)));
            match cancelled {
                Ok(()) => {
                    let effects = {
                        let mut state = self.lock();
                        match state.find_mut(id) {
                            Some(job) if !job.status.is_terminal() => {
                                job.status = JobStatus::Stopping;
                                vec![Effect::Event(JobEvent::Stopping { job: view(job) })]
                            }
                            _ => Vec::new(),
                        }
                    };
                    self.run_effects(effects);
                }
                Err(error) => {
                    self.warn(&format!("jobs: cancel of {id} threw during teardown; job record forced failed and work may be orphaned: {error}"));
                    self.settle(
                        id,
                        JobOutcome::failed(format!(
                            "cancel threw during teardown; work may be orphaned: {error}"
                        )),
                        Some(SettleCause::Teardown),
                        false,
                    );
                }
            }
        }
    }
}

/// The handle a producer writes through while its work runs.
#[derive(Clone)]
pub struct JobHandle {
    id: String,
    shared: Weak<Shared>,
}

impl JobHandle {
    /// The job's id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Append one chunk of output.
    pub fn append(&self, text: &str, options: AppendOptions) {
        if let Some(shared) = self.shared.upgrade() {
            shared.append_ring(&self.id, text, options, Writer::Producer);
        }
    }

    /// Replace the live progress line.
    pub fn update_progress(&self, line: &str) {
        if let Some(shared) = self.shared.upgrade() {
            shared.update_progress(&self.id, line);
        }
    }
}

/// Undoes [`JobRegistry::subscribe`].
pub struct Subscription {
    shared: Weak<Shared>,
    token: u64,
}

impl Subscription {
    /// Stop listening; a second call does nothing.
    pub fn unsubscribe(&self) {
        if let Some(shared) = self.shared.upgrade() {
            shared
                .listeners
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .retain(|(token, _)| *token != self.token);
        }
    }
}

/// Undoes [`JobRegistry::attach_controller`].
pub struct ControllerAttachment {
    shared: Weak<Shared>,
    attached: AtomicBool,
}

impl ControllerAttachment {
    /// Detach; a second call does nothing.
    pub fn detach(&self) {
        if !self.attached.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(shared) = self.shared.upgrade() {
            let mut state = shared.lock();
            state.controllers = state.controllers.saturating_sub(1);
        }
    }
}

/// Removes an uncommitted placeholder if the producer's `run` panics.
struct Placeholder<'a> {
    shared: &'a Shared,
    id: String,
    armed: bool,
}

impl Drop for Placeholder<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.shared.lock().jobs.retain(|job| job.id != self.id);
        }
    }
}

/// The in-memory job registry. Every call that reads or controls a job takes the caller's session id; an owned job is
/// reachable only by its owner, an unowned one by everyone (LOCAL:564-577). Cheap to clone; clones share the jobs.
#[derive(Clone)]
pub struct JobRegistry {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for JobRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobRegistry")
            .field("jobs", &self.shared.lock().jobs.len())
            .finish_non_exhaustive()
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new(JobRegistryOptions::default())
    }
}

impl JobRegistry {
    /// A registry with these host facts.
    pub fn new(options: JobRegistryOptions) -> Self {
        let random_hex = options.random_hex.unwrap_or_else(|| {
            Arc::new(|| uuid::Uuid::new_v4().simple().to_string())
                as Arc<dyn Fn() -> String + Send + Sync>
        });
        Self {
            shared: Arc::new(Shared {
                session_exists: options.session_exists,
                record: options.record,
                warn: options.warn,
                max_concurrent_jobs_per_owner: options
                    .max_concurrent_jobs_per_owner
                    .unwrap_or(DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER),
                retain_bytes: options.retain_bytes.unwrap_or(DEFAULT_RETAIN_BYTES),
                settled_retain_bytes: options
                    .settled_retain_bytes
                    .unwrap_or(DEFAULT_SETTLED_RETAIN_BYTES),
                pump_poll_ms: options.pump_poll_ms.unwrap_or(DEFAULT_PUMP_POLL_MS),
                random_hex,
                runtime: options
                    .runtime
                    .or_else(|| tokio::runtime::Handle::try_current().ok()),
                state: Mutex::new(State::default()),
                listeners: Mutex::new(Vec::new()),
                gate: Mutex::new(()),
            }),
        }
    }

    /// Active jobs one owner may hold.
    pub fn max_concurrent_jobs_per_owner(&self) -> usize {
        self.shared.max_concurrent_jobs_per_owner
    }

    /// Live ring retention per job.
    pub fn retain_bytes(&self) -> u64 {
        self.shared.retain_bytes
    }

    /// Ring retention after settlement.
    pub fn settled_retain_bytes(&self) -> u64 {
        self.shared.settled_retain_bytes
    }

    /// The pull-source poll interval.
    pub fn pump_poll_ms(&self) -> u64 {
        self.shared.pump_poll_ms
    }

    /// Declare that something collects and stops these jobs — the job tools. DSH refuses a registration no
    /// controller serves (LOCAL:414), because a job nobody can read or kill is a leak.
    pub fn attach_controller(&self, _name: &str) -> ControllerAttachment {
        self.shared.lock().controllers += 1;
        ControllerAttachment {
            shared: Arc::downgrade(&self.shared),
            attached: AtomicBool::new(true),
        }
    }

    /// Listen to every lifecycle and output event. A panicking listener is reported, not fatal.
    pub fn subscribe(&self, listener: impl Fn(&JobEvent) + Send + Sync + 'static) -> Subscription {
        let token = self.shared.lock().token();
        self.shared
            .listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((token, Arc::new(listener)));
        Subscription {
            shared: Arc::downgrade(&self.shared),
            token,
        }
    }

    /// Register one job and answer its id.
    ///
    /// The preflight runs in DSH's order (LOCAL:412-419, 537-544): the owner, a controller, the kind, the label, the
    /// output limit, then the per-owner cap.
    pub fn start(&self, spec: JobSpec) -> Result<String, JobError> {
        let shared = &self.shared;
        let _gate = shared.gate();
        let JobSpec {
            kind,
            label,
            owner,
            tool_call,
            output_limit_bytes,
            output,
            run,
        } = spec;
        if shared.lock().disposed {
            return Err(JobError::new(codes::JOB_DISPOSED, "jobs service disposed"));
        }
        if let Some(owner) = &owner {
            match &shared.session_exists {
                None => {
                    return Err(JobError::new(
                        codes::JOB_OWNER_UNAVAILABLE,
                        "background job ownership requires the session store (load the session row)",
                    ));
                }
                Some(exists) if !exists(owner) => {
                    return Err(JobError::new(
                        codes::JOB_OWNER_UNAVAILABLE,
                        format!(
                            "session \"{owner}\" has no live agent (background job owner must be live)"
                        ),
                    ));
                }
                Some(_) => {}
            }
        }
        let id = {
            let mut state = shared.lock();
            if state.controllers == 0 {
                return Err(JobError::new(
                    codes::JOB_UNAVAILABLE,
                    "background jobs unavailable: no job controller serves this agent (load the jobs row, src/plugins/jobs.ts, in its composition)",
                ));
            }
            if kind.is_empty() {
                return Err(JobError::new(
                    codes::JOB_INVALID_ARGS,
                    "invalid job kind: expected a non-empty string",
                ));
            }
            if label.is_empty() {
                return Err(JobError::new(
                    codes::JOB_INVALID_ARGS,
                    "invalid job label: expected a non-empty string",
                ));
            }
            if let Some(limit) = output_limit_bytes
                && (!is_safe_integer(limit) || limit <= 0.0)
            {
                return Err(JobError::new(
                    codes::JOB_INVALID_ARGS,
                    format!(
                        "invalid outputLimitBytes: expected a positive safe integer, got {}",
                        json_number(limit)
                    ),
                ));
            }
            let active = state
                .jobs
                .iter()
                .filter(|job| {
                    job.owner == owner
                        && matches!(job.status, JobStatus::Running | JobStatus::Stopping)
                })
                .count();
            if active >= shared.max_concurrent_jobs_per_owner {
                return Err(JobError::new(
                    codes::JOB_LIMIT,
                    format!(
                        "background job limit reached for this owner (limit: {}); use job_kill to stop an unneeded job, wait for it to finish, then retry",
                        shared.max_concurrent_jobs_per_owner
                    ),
                ));
            }
            if shared.runtime.is_none() && tokio::runtime::Handle::try_current().is_err() {
                return Err(JobError::new(
                    codes::JOB_UNAVAILABLE,
                    "background jobs unavailable: no async runtime is running",
                ));
            }
            let id = loop {
                let hex: String = (shared.random_hex)().chars().take(16).collect();
                let candidate = format!("{kind}-{hex}");
                if state.find(&candidate).is_none() {
                    break candidate;
                }
            };
            let (settled, _) = watch::channel(false);
            state.jobs.push(JobRecord {
                id: id.clone(),
                kind,
                label,
                owner,
                tool_call,
                output_limit_bytes: output_limit_bytes.map(|limit| limit as u64),
                cancel: None,
                committed: false,
                ring: OutputRing::new(),
                progress: None,
                status: JobStatus::Running,
                model_cursor: 0,
                result_delivered: false,
                detail: None,
                result: None,
                started_at: 0,
                finished_at: None,
                kill_reason: None,
                settle_cause: None,
                settled,
                waiters: Vec::new(),
                spill_paths: Vec::new(),
            });
            id
        };
        let mut placeholder = Placeholder {
            shared,
            id: id.clone(),
            armed: true,
        };
        let handle = JobHandle {
            id: id.clone(),
            shared: Arc::downgrade(shared),
        };
        let runtime = shared
            .runtime
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
            .expect("checked in the preflight");
        // A producer spawns its work inside `run`, so it runs in the registry's runtime.
        let JobHooks { cancel, done } = {
            let _entered = runtime.enter();
            run(handle)
        };
        let (settled, effects) = {
            let mut state = shared.lock();
            let job = state
                .find_mut(&id)
                .expect("the placeholder is held until it commits");
            job.cancel = Some(Arc::new(cancel));
            job.committed = true;
            job.started_at = now_ms();
            let mut effects = Vec::new();
            effects.extend(shared.record_effect(job, "job/registered", record_base(job)));
            effects.push(Effect::Event(JobEvent::Registered { job: view(job) }));
            (job.settled.subscribe(), effects)
        };
        placeholder.armed = false;
        shared.run_effects(effects);

        let (stop, stopped) = watch::channel(false);
        let pump = (!output.is_empty()).then(|| {
            runtime.spawn(pump(
                Arc::downgrade(shared),
                id.clone(),
                output,
                shared.pump_poll_ms,
                stopped,
                settled,
            ))
        });
        let weak = Arc::downgrade(shared);
        let settle_id = id.clone();
        let spawner = runtime.clone();
        runtime.spawn(async move {
            let (outcome, reported) = match spawner.spawn(done).await {
                Ok(outcome) => (outcome, true),
                Err(error) => {
                    if let Some(shared) = weak.upgrade() {
                        shared.warn(&format!("jobs: job {settle_id} producer done promise rejected (producer contract violation): {error}"));
                    }
                    (JobOutcome::failed(error.to_string()), false)
                }
            };
            stop.send_replace(true);
            if let Some(pump) = pump {
                let _ = pump.await;
            }
            if let Some(shared) = weak.upgrade() {
                shared.settle(&settle_id, outcome, None, reported);
            }
        });
        Ok(id)
    }

    /// The caller's jobs plus the unowned ones, in registration order.
    pub fn list(&self, caller: Option<&str>) -> Vec<JobView> {
        self.shared
            .lock()
            .jobs
            .iter()
            .filter(|job| job.committed && (job.owner.is_none() || job.owner.as_deref() == caller))
            .map(view)
            .collect()
    }

    /// One job's view; moves nothing.
    pub fn get(&self, id: &str, caller: Option<&str>) -> Result<JobView, JobError> {
        let mut state = self.shared.lock();
        state.expect(id, caller).map(|job| view(job))
    }

    /// The one **consuming** read: the delta since the model's cursor, which then moves to the end. The result
    /// rides the first read after settle, once. A read of a settled job drops its ring to the settled cap
    /// (LOCAL:631-643).
    pub fn read(&self, id: &str, caller: Option<&str>) -> Result<JobRead, JobError> {
        let settled_cap = self.shared.settled_retain_bytes;
        let mut state = self.shared.lock();
        let job = state.expect(id, caller)?;
        let read = job.ring.read_from(job.model_cursor);
        job.model_cursor = job.ring.total;
        let terminal = job.status.is_terminal();
        let result = if terminal && !job.result_delivered {
            job.result.clone()
        } else {
            None
        };
        if result.is_some() {
            job.result_delivered = true;
        }
        if terminal {
            job.ring.trim(settled_cap);
        }
        Ok(JobRead {
            chunks: read.chunks,
            lossy: read.lossy,
            result,
            job: view(job),
        })
    }

    /// A **non-consuming** read from an absolute offset: the page's follow, which never moves the model's cursor.
    pub fn read_at(&self, id: &str, from: f64, caller: Option<&str>) -> Result<RingRead, JobError> {
        let mut state = self.shared.lock();
        let job = state.expect(id, caller)?;
        if !is_safe_integer(from) || from < 0.0 {
            return Err(JobError::new(
                codes::JOB_INVALID_ARGS,
                format!(
                    "invalid output read offset: expected a non-negative safe integer, got {}",
                    json_number(from)
                ),
            ));
        }
        Ok(job.ring.read_from(from as u64))
    }

    /// Ask a job to stop, and answer at once. The job settles when its work actually ends.
    pub fn kill(
        &self,
        id: &str,
        caller: Option<&str>,
        reason: Option<&str>,
    ) -> Result<KillOutcome, JobError> {
        self.kill_with(id, caller, reason, || {})
    }

    /// [`kill`](Self::kill), calling `requested` when the kill was requested, before the job can settle — how the
    /// job tools mark a model's own kill so its settle sends no notice, with no window in between.
    pub fn kill_with(
        &self,
        id: &str,
        caller: Option<&str>,
        reason: Option<&str>,
        requested: impl FnOnce(),
    ) -> Result<KillOutcome, JobError> {
        let _gate = self.shared.gate();
        self.shared.lock().expect(id, caller)?;
        let outcome = self.shared.kill_job(id, reason)?;
        if outcome == KillOutcome::Requested {
            requested();
        }
        Ok(outcome)
    }

    /// Wait until the job settles or `timeout_ms` passes, then answer its view. A timeout is not an error and leaves
    /// the job running; a stop while it is live is `wait aborted` (LOCAL:656-689).
    pub async fn wait(
        &self,
        id: &str,
        timeout_ms: f64,
        caller: Option<&str>,
        cancel: Option<CancellationToken>,
    ) -> Result<JobView, JobError> {
        let (receiver, token) = {
            let mut state = self.shared.lock();
            state.expect(id, caller)?;
            if !timeout_ms.is_finite() || timeout_ms <= 0.0 {
                return Err(JobError::new(
                    codes::JOB_INVALID_ARGS,
                    format!(
                        "invalid wait timeout: expected a positive number of milliseconds, got {}",
                        json_number(timeout_ms)
                    ),
                ));
            }
            let token = state.token();
            let job = state.expect(id, caller)?;
            if job.status.is_terminal() {
                return Ok(view(job));
            }
            if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
                return Err(JobError::new(codes::JOB_WAIT_ABORTED, "wait aborted"));
            }
            let (sender, receiver) = oneshot::channel();
            job.waiters.push((token, sender));
            (receiver, token)
        };
        let stopped = async {
            match &cancel {
                Some(cancel) => cancel.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        let timer = tokio::time::sleep(Duration::from_secs_f64(
            (timeout_ms / 1000.0).min(365.0 * 24.0 * 3600.0),
        ));
        tokio::select! {
            released = receiver => {
                if let Ok(job) = released {
                    return Ok(job);
                }
            }
            () = timer => {}
            () = stopped => {
                self.forget_waiter(id, token);
                return Err(JobError::new(codes::JOB_WAIT_ABORTED, "wait aborted"));
            }
        }
        self.forget_waiter(id, token);
        let state = self.shared.lock();
        state
            .find(id)
            .map(view)
            .ok_or_else(|| JobError::new(codes::JOB_UNKNOWN, format!("unknown job {id}")))
    }

    fn forget_waiter(&self, id: &str, token: u64) {
        if let Some(job) = self.shared.lock().find_mut(id) {
            job.waiters.retain(|(waiter, _)| *waiter != token);
        }
    }

    /// Forget a settled job. A live one is refused with DSH's sentence.
    pub fn remove(&self, id: &str, caller: Option<&str>) -> Result<(), JobError> {
        let _gate = self.shared.gate();
        {
            let mut state = self.shared.lock();
            let job = state.expect(id, caller)?;
            if !job.status.is_terminal() {
                return Err(JobError::new(
                    codes::JOB_LIVE,
                    format!(
                        "job {id} is still {}; kill it and wait for settlement before removing it",
                        job.status.as_str()
                    ),
                ));
            }
        }
        self.shared.drop_jobs(&[id.to_owned()]);
        Ok(())
    }

    /// Kill every live job one session owns, with one reason — DSH kills an archived session's jobs with
    /// `session archived` (`dsh-jobs/lib/index.js:19-43`). Answers the ids asked to stop.
    pub fn kill_owned_by(&self, session: &str, reason: &str) -> Vec<String> {
        let _gate = self.shared.gate();
        let ids: Vec<String> = self
            .shared
            .lock()
            .jobs
            .iter()
            .filter(|job| {
                job.committed && job.owner.as_deref() == Some(session) && !job.status.is_terminal()
            })
            .map(|job| job.id.clone())
            .collect();
        let mut killed = Vec::new();
        for id in ids {
            match self.shared.kill_job(&id, Some(reason)) {
                Ok(KillOutcome::Requested) => killed.push(id),
                Ok(KillOutcome::AlreadyFinished) => {}
                Err(error) => self
                    .shared
                    .warn(&format!("jobs: cancel of {id} threw: {error}")),
            }
        }
        killed
    }

    /// Cancel every live job with `jobs service disposed`, wait for each to settle, and drop every record
    /// (LOCAL:831-839). A cancel that fails force-fails its record rather than stalling the teardown.
    pub async fn dispose(&self) {
        if let Some(rest) = self.begin_dispose() {
            rest.await;
        }
    }

    /// [`dispose`](Self::dispose) from synchronous code: the cancels run now, and the wait and the drop run on the
    /// registry's runtime.
    pub fn dispose_in_background(&self) {
        if let Some(rest) = self.begin_dispose() {
            match self
                .shared
                .runtime
                .clone()
                .or_else(|| tokio::runtime::Handle::try_current().ok())
            {
                Some(runtime) => {
                    runtime.spawn(rest);
                }
                None => drop(rest),
            }
        }
    }

    /// [`dispose`](Self::dispose) from synchronous code that may be the process's last step: the binary's boot
    /// disposal after the server stopped (issue #129). Outside any runtime it blocks on the registry's runtime until
    /// every live job settled, or `limit` passed, so each settle reaches the session log as `job/settled` before the
    /// process exits. The TypeScript teardown awaits the same settles. Inside a runtime it cannot block, so it
    /// behaves as [`dispose_in_background`](Self::dispose_in_background).
    pub fn dispose_blocking(&self, limit: std::time::Duration) {
        let Some(rest) = self.begin_dispose() else {
            return;
        };
        if let Ok(current) = tokio::runtime::Handle::try_current() {
            current.spawn(rest);
            return;
        }
        match self.shared.runtime.clone() {
            Some(runtime) => {
                // The timer is made inside `block_on`: built out here it would find no runtime to register with.
                runtime.block_on(async move {
                    let _ = tokio::time::timeout(limit, rest).await;
                });
            }
            None => drop(rest),
        }
    }

    fn begin_dispose(&self) -> Option<BoxFuture<'static, ()>> {
        let shared = Arc::clone(&self.shared);
        let gate = shared.gate();
        let (ids, settled) = {
            let mut state = shared.lock();
            if state.disposed {
                return None;
            }
            state.disposed = true;
            let ids: Vec<String> = state.jobs.iter().map(|job| job.id.clone()).collect();
            let settled: Vec<watch::Receiver<bool>> = state
                .jobs
                .iter()
                .map(|job| job.settled.subscribe())
                .collect();
            (ids, settled)
        };
        shared.cancel_for_teardown(&ids, "jobs service disposed");
        drop(gate);
        Some(Box::pin(async move {
            for mut receiver in settled {
                let _ = receiver.wait_for(|settled| *settled).await;
            }
            shared.drop_jobs(&ids);
        }))
    }

    #[cfg(test)]
    fn settle_for_test(&self, id: &str, outcome: JobOutcome) {
        self.shared.settle(id, outcome, None, true);
    }
}

/// Drain every source in order, sleep `poll_ms` or until the producer is done or the job settled, repeat, then
/// drain once more (DSH's `startPump`, LOCAL:120-161). A lossy read lands as a `gapBefore` chunk so the
/// discontinuity stays visible; a failing source is reported once and reads as exhausted from then on
/// (LOCAL:711-734).
async fn pump(
    shared: Weak<Shared>,
    id: String,
    mut sources: Vec<Box<dyn PullSource>>,
    poll_ms: u64,
    mut stopped: watch::Receiver<bool>,
    mut settled: watch::Receiver<bool>,
) {
    let mut cursors = vec![0u64; sources.len()];
    let mut failed = vec![false; sources.len()];
    let mut drain = |sources: &mut Vec<Box<dyn PullSource>>| {
        let Some(shared) = shared.upgrade() else {
            return;
        };
        for (index, source) in sources.iter_mut().enumerate() {
            let read = if failed[index] {
                PullRead {
                    next_offset: cursors[index],
                    ..PullRead::default()
                }
            } else {
                match source.read(cursors[index]) {
                    Ok(read) => read,
                    Err(error) => {
                        failed[index] = true;
                        shared.warn(&format!(
                            "jobs: output source for {id} failed; its stream stops here: {error}"
                        ));
                        PullRead {
                            next_offset: cursors[index],
                            ..PullRead::default()
                        }
                    }
                }
            };
            cursors[index] = read.next_offset;
            shared.set_spill(&id, index, read.spill_path);
            if read.text.is_empty() {
                continue;
            }
            let options = AppendOptions {
                channel: source.channel(),
                gap_before: read.lossy.then_some(true),
            };
            shared.append_ring(&id, &read.text, options, Writer::Pump);
        }
    };
    loop {
        if *stopped.borrow() || *settled.borrow() {
            break;
        }
        drain(&mut sources);
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(poll_ms.max(1))) => {}
            changed = stopped.changed() => if changed.is_err() { break; },
            changed = settled.changed() => if changed.is_err() { break; },
        }
    }
    drain(&mut sources);
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// A producer the test drives by hand: append through `handle`, end with `finish`.
    pub(crate) struct Manual {
        pub handle: Arc<StdMutex<Option<JobHandle>>>,
        pub cancels: Arc<StdMutex<Vec<Option<String>>>>,
        finish: Arc<StdMutex<Option<oneshot::Sender<JobOutcome>>>>,
    }

    impl Manual {
        pub fn handle(&self) -> JobHandle {
            self.handle.lock().unwrap().clone().expect("run was called")
        }

        pub fn finish(&self, outcome: JobOutcome) {
            if let Some(sender) = self.finish.lock().unwrap().take() {
                let _ = sender.send(outcome);
            }
        }

        pub fn cancels(&self) -> Vec<Option<String>> {
            self.cancels.lock().unwrap().clone()
        }
    }

    /// A manual producer of `kind`/`label`, optionally owned; `finish_on_cancel` ends it with the kill.
    pub(crate) fn manual_spec(
        owner: Option<&str>,
        label: &str,
        finish_on_cancel: Option<JobOutcome>,
    ) -> (JobSpec, Manual) {
        let handle = Arc::new(StdMutex::new(None));
        let cancels = Arc::new(StdMutex::new(Vec::new()));
        let finish: Arc<StdMutex<Option<oneshot::Sender<JobOutcome>>>> =
            Arc::new(StdMutex::new(None));
        let (sender, receiver) = oneshot::channel::<JobOutcome>();
        *finish.lock().unwrap() = Some(sender);
        let manual = Manual {
            handle: Arc::clone(&handle),
            cancels: Arc::clone(&cancels),
            finish: Arc::clone(&finish),
        };
        let mut spec = JobSpec::new("bash", label, move |h: JobHandle| {
            *handle.lock().unwrap() = Some(h);
            JobHooks {
                cancel: Box::new(move |reason: Option<&str>| {
                    cancels.lock().unwrap().push(reason.map(str::to_owned));
                    if let Some(outcome) = &finish_on_cancel
                        && let Some(sender) = finish.lock().unwrap().take()
                    {
                        let _ = sender.send(outcome.clone());
                    }
                    Ok(())
                }),
                done: Box::pin(async move {
                    match receiver.await {
                        Ok(outcome) => outcome,
                        Err(_) => futures::future::pending().await,
                    }
                }),
            }
        });
        spec.owner = owner.map(str::to_owned);
        (spec, manual)
    }

    fn manual(owner: Option<&str>) -> (JobSpec, Manual) {
        manual_spec(owner, "sleep 30", None)
    }

    pub(crate) type Events = Arc<StdMutex<Vec<JobEvent>>>;
    type Records = Arc<StdMutex<Vec<(String, String, Map<String, Value>)>>>;

    /// A registry with a controller attached and every `session-*` existing, recording log events.
    fn registry_with(options: JobRegistryOptions) -> (JobRegistry, Records, Events) {
        let records: Records = Arc::new(StdMutex::new(Vec::new()));
        let sink = Arc::clone(&records);
        let mut options = options;
        if options.session_exists.is_none() {
            options.session_exists = Some(Arc::new(|id: &str| id.starts_with("session-")));
        }
        options.record = Some(Arc::new(move |session: &str, kind: &str, data| {
            sink.lock()
                .unwrap()
                .push((session.to_owned(), kind.to_owned(), data));
            Ok(())
        }));
        let jobs = JobRegistry::new(options);
        let _ = jobs.attach_controller("test");
        let events: Events = Arc::new(StdMutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        let _ = jobs.subscribe(move |event| seen.lock().unwrap().push(event.clone()));
        (jobs, records, events)
    }

    fn registry() -> (JobRegistry, Records, Events) {
        registry_with(JobRegistryOptions::default())
    }

    pub(crate) async fn settled_of(events: &Events, id: &str) -> (JobView, SettleCause, bool) {
        for _ in 0..400 {
            let found = events.lock().unwrap().iter().find_map(|event| match event {
                JobEvent::Settled {
                    job,
                    cause,
                    awaited,
                } if job.id == id => Some((job.clone(), *cause, *awaited)),
                _ => None,
            });
            if let Some(found) = found {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("job {id} never settled");
    }

    fn refused(result: Result<impl std::fmt::Debug, JobError>, code: &str, message: &str) {
        let error = result.expect_err("a refusal");
        assert_eq!(error.code, code);
        assert_eq!(error.message, message);
    }

    fn outcome(status: OutcomeStatus, detail: Option<&str>) -> JobOutcome {
        JobOutcome::new(status, detail)
    }

    fn texts(chunks: &[JobChunk]) -> Vec<&str> {
        chunks.iter().map(|chunk| chunk.text.as_str()).collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_id_is_kind_and_16_hex_rerolled_on_a_collision() {
        let rolls = Arc::new(StdMutex::new(vec![
            "0123456789abcdef0000".to_owned(),
            "0123456789abcdef1111".to_owned(),
            "fedcba98765432100000".to_owned(),
        ]));
        let (jobs, _, _) = registry_with(JobRegistryOptions {
            random_hex: Some(Arc::new(move || {
                let mut rolls = rolls.lock().unwrap();
                if rolls.is_empty() {
                    "ffffffffffffffff".to_owned()
                } else {
                    rolls.remove(0)
                }
            })),
            ..JobRegistryOptions::default()
        });
        assert_eq!(jobs.start(manual(None).0).unwrap(), "bash-0123456789abcdef");
        assert_eq!(
            jobs.start(manual(None).0).unwrap(),
            "bash-fedcba9876543210",
            "the colliding roll was discarded"
        );
        let (real, _, _) = registry();
        let id = real.start(manual(None).0).unwrap();
        let hex = id.strip_prefix("bash-").unwrap();
        assert_eq!(hex.len(), 16);
        assert!(
            hex.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn preflight_runs_in_dsh_order_with_dsh_texts() {
        let no_store = JobRegistry::new(JobRegistryOptions::default());
        let _ = no_store.attach_controller("t");
        refused(
            no_store.start(manual(Some("session-a")).0),
            codes::JOB_OWNER_UNAVAILABLE,
            "background job ownership requires the session store (load the session row)",
        );
        // The owner is checked before the controller, the kind, the label and the limit.
        let bare = JobRegistry::new(JobRegistryOptions {
            session_exists: Some(Arc::new(|_: &str| false)),
            ..JobRegistryOptions::default()
        });
        let (mut spec, _) = manual(Some("gone"));
        spec.kind = String::new();
        spec.label = String::new();
        refused(
            bare.start(spec),
            codes::JOB_OWNER_UNAVAILABLE,
            "session \"gone\" has no live agent (background job owner must be live)",
        );
        let (mut spec, _) = manual(None);
        spec.kind = String::new();
        refused(
            bare.start(spec),
            codes::JOB_UNAVAILABLE,
            "background jobs unavailable: no job controller serves this agent (load the jobs row, src/plugins/jobs.ts, in its composition)",
        );
        let (jobs, _, _) = registry();
        let (mut spec, _) = manual(None);
        spec.kind = String::new();
        spec.label = String::new();
        refused(
            jobs.start(spec),
            codes::JOB_INVALID_ARGS,
            "invalid job kind: expected a non-empty string",
        );
        let (mut spec, _) = manual(None);
        spec.label = String::new();
        refused(
            jobs.start(spec),
            codes::JOB_INVALID_ARGS,
            "invalid job label: expected a non-empty string",
        );
        let (mut spec, _) = manual(None);
        spec.output_limit_bytes = Some(1.5);
        refused(
            jobs.start(spec),
            codes::JOB_INVALID_ARGS,
            "invalid outputLimitBytes: expected a positive safe integer, got 1.5",
        );
        let (mut spec, _) = manual(None);
        spec.output_limit_bytes = Some(0.0);
        refused(
            jobs.start(spec),
            codes::JOB_INVALID_ARGS,
            "invalid outputLimitBytes: expected a positive safe integer, got 0",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_owner_holds_at_most_the_cap_and_a_stopping_job_keeps_its_slot() {
        let (jobs, _, events) = registry_with(JobRegistryOptions {
            max_concurrent_jobs_per_owner: Some(2),
            ..JobRegistryOptions::default()
        });
        let (spec, one) = manual(Some("session-a"));
        let a = jobs.start(spec).unwrap();
        jobs.start(manual(Some("session-a")).0).unwrap();
        let limit = "background job limit reached for this owner (limit: 2); use job_kill to stop an unneeded job, wait for it to finish, then retry";
        refused(
            jobs.start(manual(Some("session-a")).0),
            codes::JOB_LIMIT,
            limit,
        );
        jobs.start(manual(Some("session-b")).0).unwrap();
        jobs.start(manual(None).0).unwrap();
        jobs.kill(&a, Some("session-a"), None).unwrap();
        refused(
            jobs.start(manual(Some("session-a")).0),
            codes::JOB_LIMIT,
            limit,
        );
        one.finish(outcome(OutcomeStatus::Killed, Some("signal: SIGTERM")));
        settled_of(&events, &a).await;
        assert!(
            jobs.start(manual(Some("session-a")).0)
                .unwrap()
                .starts_with("bash-")
        );
        let defaults = JobRegistry::default();
        assert_eq!(defaults.max_concurrent_jobs_per_owner(), 10);
        assert_eq!(defaults.retain_bytes(), 262_144);
        assert_eq!(defaults.settled_retain_bytes(), 16_384);
        assert_eq!(defaults.pump_poll_ms(), 150);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_consuming_read_moves_the_cursor_and_read_at_never_does() {
        let (jobs, _, _) = registry();
        let (spec, producer) = manual(Some("session-a"));
        let id = jobs.start(spec).unwrap();
        let stdout = AppendOptions::channel(JobChannel::Stdout);
        producer.handle().append("one\n", stdout);
        let caller = Some("session-a");
        assert_eq!(
            texts(&jobs.read_at(&id, 0.0, caller).unwrap().chunks),
            ["one\n"]
        );
        assert_eq!(texts(&jobs.read(&id, caller).unwrap().chunks), ["one\n"]);
        producer.handle().append("two\n", stdout);
        assert_eq!(
            texts(&jobs.read_at(&id, 0.0, caller).unwrap().chunks),
            ["one\n", "two\n"]
        );
        assert_eq!(jobs.read_at(&id, 4.0, caller).unwrap().next, 8);
        assert_eq!(
            texts(&jobs.read(&id, caller).unwrap().chunks),
            ["two\n"],
            "the second consuming read has only the new output"
        );
        assert!(jobs.read(&id, caller).unwrap().chunks.is_empty());
        refused(
            jobs.read_at(&id, -1.0, caller),
            codes::JOB_INVALID_ARGS,
            "invalid output read offset: expected a non-negative safe integer, got -1",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_result_rides_the_first_consuming_read_after_settle_once() {
        let (jobs, _, events) = registry();
        let (spec, producer) = manual(None);
        let id = jobs.start(spec).unwrap();
        assert_eq!(jobs.read(&id, None).unwrap().result, None);
        producer.finish(JobOutcome {
            status: OutcomeStatus::Completed,
            detail: Some("done".into()),
            result: Some("the answer".into()),
        });
        settled_of(&events, &id).await;
        assert_eq!(
            jobs.read(&id, None).unwrap().result.as_deref(),
            Some("the answer")
        );
        assert_eq!(jobs.read(&id, None).unwrap().result, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settle_trims_to_the_unread_bytes_and_a_terminal_read_drops_to_the_settled_cap() {
        let (jobs, _, events) = registry_with(JobRegistryOptions {
            retain_bytes: Some(100),
            settled_retain_bytes: Some(10),
            ..JobRegistryOptions::default()
        });
        let (spec, producer) = manual(None);
        let id = jobs.start(spec).unwrap();
        for _ in 0..5 {
            producer
                .handle()
                .append("0123456789", AppendOptions::default());
        }
        producer.finish(outcome(OutcomeStatus::Completed, Some("exit code: 0")));
        settled_of(&events, &id).await;
        assert_eq!(
            jobs.get(&id, None).unwrap().output.earliest,
            0,
            "every unread byte is kept for the model"
        );
        assert_eq!(jobs.read(&id, None).unwrap().chunks.len(), 5);
        assert_eq!(
            jobs.get(&id, None).unwrap().output.earliest,
            40,
            "after the terminal read only the settled cap remains"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn kill_cancels_first_and_the_settle_merges_the_reason_into_the_detail() {
        let (jobs, records, events) = registry();
        let (spec, producer) = manual(Some("session-a"));
        let id = jobs.start(spec).unwrap();
        let caller = Some("session-a");
        assert_eq!(
            jobs.kill(&id, caller, Some("no longer needed")).unwrap(),
            KillOutcome::Requested
        );
        assert_eq!(producer.cancels(), [Some("no longer needed".to_owned())]);
        assert_eq!(jobs.get(&id, caller).unwrap().status, JobStatus::Stopping);
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event.kind() == "stopping")
        );
        producer.finish(outcome(OutcomeStatus::Killed, Some("signal: SIGTERM")));
        let (job, cause, awaited) = settled_of(&events, &id).await;
        assert_eq!(cause, SettleCause::Kill);
        assert!(!awaited);
        assert_eq!(job.status, JobStatus::Killed);
        assert_eq!(
            job.detail.as_deref(),
            Some("signal: SIGTERM; no longer needed")
        );
        assert_eq!(
            jobs.kill(&id, caller, None).unwrap(),
            KillOutcome::AlreadyFinished
        );
        let records = records.lock().unwrap();
        let logged = records
            .iter()
            .find(|(_, kind, _)| kind == "job/settled")
            .unwrap();
        assert_eq!(logged.2["cause"], "kill");
        assert_eq!(logged.2["detail"], "signal: SIGTERM; no longer needed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancel_that_fails_leaves_the_job_as_it_was() {
        let (jobs, _, _) = registry();
        let id = jobs
            .start(JobSpec::new("bash", "x", |_| JobHooks {
                cancel: Box::new(|_: Option<&str>| Err("cannot stop".to_owned())),
                done: Box::pin(futures::future::pending()),
            }))
            .unwrap();
        let error = jobs.kill(&id, None, None).unwrap_err();
        assert_eq!(error.code, codes::JOB_CANCEL_FAILED);
        assert!(error.message.contains("cannot stop"));
        assert_eq!(jobs.get(&id, None).unwrap().status, JobStatus::Running);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settle_is_first_wins_and_clears_progress() {
        let (jobs, _, events) = registry();
        let (spec, producer) = manual(None);
        let id = jobs.start(spec).unwrap();
        producer.handle().update_progress("50%");
        assert_eq!(
            jobs.get(&id, None).unwrap().progress.as_deref(),
            Some("50%")
        );
        producer.finish(outcome(OutcomeStatus::Completed, Some("exit code: 0")));
        settled_of(&events, &id).await;
        jobs.settle_for_test(&id, outcome(OutcomeStatus::Failed, Some("late")));
        let view = jobs.get(&id, None).unwrap();
        assert_eq!(view.status, JobStatus::Completed);
        assert_eq!(view.detail.as_deref(), Some("exit code: 0"));
        assert_eq!(view.progress, None);
        assert!(view.finished_at.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_wait_that_times_out_leaves_the_job_running_and_a_released_waiter_marks_the_settle_awaited()
     {
        let (jobs, _, events) = registry();
        let (spec, producer) = manual(None);
        let id = jobs.start(spec).unwrap();
        let timed_out = jobs.wait(&id, 20.0, None, None).await.unwrap();
        assert_eq!(timed_out.status, JobStatus::Running);
        refused(
            jobs.wait(&id, 0.0, None, None).await,
            codes::JOB_INVALID_ARGS,
            "invalid wait timeout: expected a positive number of milliseconds, got 0",
        );
        let stop = CancellationToken::new();
        let waiting = {
            let jobs = jobs.clone();
            let id = id.clone();
            let stop = stop.clone();
            tokio::spawn(async move { jobs.wait(&id, 10_000.0, None, Some(stop)).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        stop.cancel();
        refused(
            waiting.await.unwrap(),
            codes::JOB_WAIT_ABORTED,
            "wait aborted",
        );
        let waiting = {
            let jobs = jobs.clone();
            let id = id.clone();
            tokio::spawn(async move { jobs.wait(&id, 10_000.0, None, None).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        producer.finish(outcome(OutcomeStatus::Completed, Some("exit code: 0")));
        assert_eq!(waiting.await.unwrap().unwrap().status, JobStatus::Completed);
        assert!(settled_of(&events, &id).await.2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_forgets_a_settled_job_and_refuses_a_live_one() {
        let (jobs, _, events) = registry();
        let (spec, producer) = manual(None);
        let id = jobs.start(spec).unwrap();
        refused(
            jobs.remove(&id, None),
            codes::JOB_LIVE,
            &format!(
                "job {id} is still running; kill it and wait for settlement before removing it"
            ),
        );
        producer.finish(outcome(OutcomeStatus::Completed, None));
        settled_of(&events, &id).await;
        jobs.remove(&id, None).unwrap();
        assert!(events.lock().unwrap().iter().any(|event| matches!(
            event,
            JobEvent::Removed { job } if job.id == id
        )));
        refused(
            jobs.get(&id, None),
            codes::JOB_UNKNOWN,
            &format!("unknown job {id}"),
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_owned_job_is_refused_to_another_session_and_an_unowned_one_is_open_to_all() {
        let (jobs, _, _) = registry();
        let owned = jobs.start(manual(Some("session-a")).0).unwrap();
        let open = jobs.start(manual(None).0).unwrap();
        let foreign = format!("job {owned} belongs to another session");
        let b = Some("session-b");
        refused(jobs.get(&owned, b), codes::JOB_FOREIGN, &foreign);
        refused(jobs.read(&owned, b), codes::JOB_FOREIGN, &foreign);
        refused(jobs.read_at(&owned, 0.0, b), codes::JOB_FOREIGN, &foreign);
        refused(jobs.kill(&owned, b, None), codes::JOB_FOREIGN, &foreign);
        refused(jobs.get(&owned, None), codes::JOB_FOREIGN, &foreign);
        refused(
            jobs.get("bash-0000000000000000", Some("session-a")),
            codes::JOB_UNKNOWN,
            "unknown job bash-0000000000000000",
        );
        assert_eq!(jobs.get(&open, b).unwrap().id, open);
        let ids = |caller| {
            jobs.list(caller)
                .into_iter()
                .map(|job| job.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(b), std::slice::from_ref(&open));
        assert_eq!(ids(Some("session-a")), [owned, open], "registration order");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn owned_jobs_write_job_registered_and_job_settled_with_dsh_fields() {
        let (jobs, records, events) = registry();
        let (mut spec, producer) = manual(Some("session-a"));
        spec.tool_call = Some(JobToolCall {
            call_id: "call_1".into(),
            root_call_id: "call_1".into(),
        });
        let id = jobs.start(spec).unwrap();
        producer.finish(outcome(OutcomeStatus::Completed, Some("exit code: 0")));
        settled_of(&events, &id).await;
        let (spec, unowned) = manual(None);
        let other = jobs.start(spec).unwrap();
        unowned.finish(outcome(OutcomeStatus::Completed, None));
        settled_of(&events, &other).await;
        let records = records.lock().unwrap();
        assert_eq!(records.len(), 2);
        let (session, kind, data) = &records[0];
        assert_eq!(session, "session-a");
        assert_eq!(kind, "job/registered");
        assert_eq!(
            data.keys().map(String::as_str).collect::<Vec<_>>(),
            ["jobId", "owner", "kind", "label", "startedAt", "toolCall"]
        );
        assert_eq!(
            data["toolCall"],
            json!({ "callId": "call_1", "rootCallId": "call_1" })
        );
        let (_, kind, data) = &records[1];
        assert_eq!(kind, "job/settled");
        assert_eq!(
            data.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "jobId",
                "owner",
                "kind",
                "label",
                "startedAt",
                "toolCall",
                "finishedAt",
                "status",
                "cause",
                "producerReported",
                "detail"
            ]
        );
        assert_eq!(data["cause"], "producer");
        assert_eq!(data["producerReported"], true);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_event_stream_carries_every_lifecycle_change_and_output() {
        let (jobs, _, events) = registry();
        let (spec, producer) = manual(Some("session-a"));
        let id = jobs.start(spec).unwrap();
        producer.handle().update_progress("step 1");
        producer.handle().append("x", AppendOptions::default());
        jobs.kill(&id, Some("session-a"), None).unwrap();
        producer.finish(outcome(OutcomeStatus::Killed, None));
        settled_of(&events, &id).await;
        jobs.remove(&id, Some("session-a")).unwrap();
        let events = events.lock().unwrap();
        assert_eq!(
            events.iter().map(JobEvent::kind).collect::<Vec<_>>(),
            [
                "registered",
                "progress",
                "output",
                "stopping",
                "settled",
                "output",
                "removed"
            ]
        );
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind() == "output")
                .unwrap(),
            &JobEvent::Output {
                id,
                owner: Some("session-a".into()),
                total: 1
            }
        );
    }

    struct Growing(Arc<StdMutex<String>>);

    impl PullSource for Growing {
        fn channel(&self) -> Option<JobChannel> {
            Some(JobChannel::Stdout)
        }
        fn read(&mut self, from: u64) -> Result<PullRead, String> {
            let text = self.0.lock().unwrap().clone();
            Ok(PullRead {
                text: text[from as usize..].to_owned(),
                next_offset: text.len() as u64,
                lossy: false,
                spill_path: None,
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pull_sources_are_drained_on_the_poll_and_once_more_before_the_settle() {
        let (jobs, _, events) = registry_with(JobRegistryOptions {
            pump_poll_ms: Some(5),
            ..JobRegistryOptions::default()
        });
        let text = Arc::new(StdMutex::new("early\n".to_owned()));
        let (finish, finished) = oneshot::channel::<JobOutcome>();
        let mut spec = JobSpec::new("pull", "source", move |_| JobHooks {
            cancel: Box::new(|_: Option<&str>| Ok(())),
            done: Box::pin(async move { finished.await.unwrap() }),
        });
        spec.output = vec![Box::new(Growing(Arc::clone(&text)))];
        let id = jobs.start(spec).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            texts(&jobs.read_at(&id, 0.0, None).unwrap().chunks),
            ["early\n"]
        );
        text.lock().unwrap().push_str("last\n");
        finish
            .send(outcome(OutcomeStatus::Completed, None))
            .unwrap();
        settled_of(&events, &id).await;
        let read = jobs.read(&id, None).unwrap();
        assert_eq!(
            read.chunks
                .iter()
                .map(|chunk| (chunk.text.as_str(), chunk.channel))
                .collect::<Vec<_>>(),
            [
                ("early\n", Some(JobChannel::Stdout)),
                ("last\n", Some(JobChannel::Stdout))
            ],
            "the final drain ran before the settle"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispose_cancels_live_jobs_settles_them_as_teardown_and_drops_them() {
        let (jobs, _, events) = registry();
        let (spec, producer) = manual(Some("session-a"));
        let id = jobs.start(spec).unwrap();
        let disposing = {
            let jobs = jobs.clone();
            tokio::spawn(async move { jobs.dispose().await })
        };
        for _ in 0..100 {
            if !producer.cancels().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert_eq!(
            producer.cancels(),
            [Some("jobs service disposed".to_owned())]
        );
        producer.finish(outcome(OutcomeStatus::Killed, Some("signal: SIGTERM")));
        disposing.await.unwrap();
        let (_, cause, _) = settled_of(&events, &id).await;
        assert_eq!(cause, SettleCause::Teardown);
        assert!(events.lock().unwrap().iter().any(|event| matches!(
            event,
            JobEvent::Removed { job } if job.id == id
        )));
        refused(
            jobs.start(manual(None).0),
            codes::JOB_DISPOSED,
            "jobs service disposed",
        );
    }

    /// Issue #129: the binary's boot disposal runs after the server stopped, outside any runtime, and the process exits
    /// right after it. A teardown that only spawned its wait left the settle unrecorded; blocking until the settle
    /// lands puts `job/settled` in the session's log first, as the TypeScript teardown does.
    #[test]
    fn dispose_blocking_outside_a_runtime_records_the_settle_before_it_returns() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let (jobs, records, _) = {
            let _inside = runtime.enter();
            registry_with(JobRegistryOptions {
                runtime: Some(runtime.handle().clone()),
                ..JobRegistryOptions::default()
            })
        };
        let (spec, producer) = manual(Some("session-a"));
        let id = {
            let _inside = runtime.enter();
            jobs.start(spec).unwrap()
        };
        let finisher = std::thread::spawn(move || {
            for _ in 0..1000 {
                if !producer.cancels().is_empty() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            // The process group takes a moment to go after its SIGTERM.
            std::thread::sleep(Duration::from_millis(50));
            producer.finish(outcome(OutcomeStatus::Killed, Some("signal: SIGTERM")));
        });
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "the test runs outside any runtime"
        );
        jobs.dispose_blocking(Duration::from_secs(5));
        let recorded = records.lock().unwrap().iter().any(|(session, kind, data)| {
            session == "session-a"
                && kind == "job/settled"
                && data.get("jobId") == Some(&Value::String(id.clone()))
        });
        assert!(
            recorded,
            "the settle was in the log when dispose_blocking returned: {:?}",
            records.lock().unwrap()
        );
        finisher.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn kill_owned_by_stops_one_sessions_live_jobs_with_one_reason() {
        let (jobs, _, events) = registry();
        let (spec, mine) = manual(Some("session-a"));
        let id = jobs.start(spec).unwrap();
        jobs.start(manual(Some("session-b")).0).unwrap();
        assert_eq!(
            jobs.kill_owned_by("session-a", "session archived"),
            std::slice::from_ref(&id)
        );
        mine.finish(outcome(OutcomeStatus::Killed, Some("signal: SIGTERM")));
        assert_eq!(
            settled_of(&events, &id).await.0.detail.as_deref(),
            Some("signal: SIGTERM; session archived")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_view_serializes_with_the_typescript_keys_in_order() {
        let (jobs, _, _) = registry();
        let id = jobs.start(manual(Some("session-a")).0).unwrap();
        let view = serde_json::to_value(jobs.get(&id, Some("session-a")).unwrap()).unwrap();
        assert_eq!(
            view.as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "id",
                "kind",
                "label",
                "owner",
                "status",
                "startedAt",
                "output"
            ]
        );
        assert_eq!(view["output"], json!({ "total": 0, "earliest": 0 }));
        assert_eq!(view["status"], "running");
    }
}
