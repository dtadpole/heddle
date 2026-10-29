//! The schedule service (`src/schedule/service.ts`): host-wide durable reminders, shared by the model's tools,
//! the page's routes and the delivery driver.
//!
//! The rules that carry weight, all DSH's (SVC:1879-2300):
//!
//! - **one FIFO** serializes create, update, delete, the archive stop and delivery; a request takes its place in
//!   the queue **when it is called**, not when its future is first polled, as a JavaScript promise chain does;
//! - **create samples its clock before queueing**, while **update samples inside the queue**;
//! - **update is a compare-and-set** on the complete record the caller observed;
//! - **every committed write** is followed by a change notification and a request to the delivery driver.
//!
//! Reads (`list`, `catalog`, `history`) are not queued: the table in memory is already the committed state.

use std::collections::BTreeSet;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;
use heddle_tools::CancellationToken;
use serde_json::{Map, Value};

use crate::errors::{ScheduleError, ScheduleErrorCode, ScheduleInputError, ScheduleLogError};
use crate::js;
use crate::rules::{
    ScheduleRecord, UpdateContent, UpdateResolution, create_after_schedule_record,
    create_at_schedule_record, create_cron_schedule_record, create_daily_schedule_record,
    create_every_schedule_record, create_weekly_schedule_record, resolve_schedule_update,
    schedule_title,
};
use crate::store::{
    DeliveryHistory, DeliveryReceipt, DeliveryRecord, ScheduleStore, ScheduleStoreError,
    ScheduleTask, TaskStatus,
};
use crate::time::{DAY_MS, parse_instant};

/// Retained delivery-history window when the deployment states none.
pub const DEFAULT_DELIVERY_HISTORY_DAYS: i64 = 30;

/// Retained delivery-history record cap when the deployment states none.
pub const DEFAULT_DELIVERY_HISTORY_RECORDS: i64 = 200;

/// The subagent refusal the service itself gives (SVC:2254-2261).
pub const SUBAGENT_TARGET_MESSAGE: &str =
    "This Session belongs to subagent routing, which never receives reminder delivery.";

/// How much delivery history each task keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScheduleRetention {
    /// The day window.
    pub days: i64,
    /// The record cap.
    pub records: i64,
}

impl ScheduleRetention {
    /// `{days, records}`.
    pub fn to_value(self) -> Value {
        let mut map = Map::new();
        map.insert("days".into(), Value::from(self.days));
        map.insert("records".into(), Value::from(self.records));
        Value::Object(map)
    }
}

/// The service's clock, in epoch milliseconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Where a contained failure is reported.
pub type Warn = Arc<dyn Fn(&str) + Send + Sync>;
/// Whether a session is a delegated child's.
pub type IsDelegated = Arc<dyn Fn(&str) -> bool + Send + Sync>;
/// A committed-write listener; an `Err` is contained and reported.
pub type ChangeListener = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// What a service is built from.
pub struct ScheduleServiceOptions {
    /// The store file, normally `$HEDDLE_HOME/schedule.json`.
    pub file: PathBuf,
    /// The clock; the system clock by default.
    pub now: Option<Clock>,
    /// Days of history each task keeps, 1-3650.
    pub retention_days: Option<i64>,
    /// Records each task keeps, 1-10000.
    pub retention_records: Option<i64>,
    /// Whether a session is a delegated child's, which no delivery may target.
    pub is_delegated: Option<IsDelegated>,
    /// Where a contained failure is reported.
    pub warn: Option<Warn>,
    /// The id generator; `schedule-<uuid>` by default.
    pub new_id: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

impl ScheduleServiceOptions {
    /// Every option at its default, over `file`.
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self {
            file: file.into(),
            now: None,
            retention_days: None,
            retention_records: None,
            is_delegated: None,
            warn: None,
            new_id: None,
        }
    }
}

/// Why a service could not be opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// A retention bound outside its range (the TypeScript `RangeError`).
    Retention(String),
    /// The store refused to open.
    Store(ScheduleStoreError),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Retention(message) => f.write_str(message),
            Self::Store(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for OpenError {}

/// Why a service operation failed rather than answering a value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceError {
    /// A supplied value that cannot become a record.
    Input(ScheduleInputError),
    /// Stored data that is wrong.
    Log(ScheduleLogError),
    /// The caller's signal was aborted before anything was written.
    Aborted,
    /// The service is stopping and accepts no more work.
    Stopping,
    /// The store could not be written.
    Store(String),
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(error) => error.fmt(f),
            Self::Log(error) => error.fmt(f),
            Self::Aborted => f.write_str("This operation was aborted"),
            Self::Stopping => f.write_str("Schedule service is stopping"),
            Self::Store(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ServiceError {}

impl From<ScheduleInputError> for ServiceError {
    fn from(error: ScheduleInputError) -> Self {
        Self::Input(error)
    }
}

impl From<ScheduleError> for ServiceError {
    fn from(error: ScheduleError) -> Self {
        match error {
            ScheduleError::Input(error) => Self::Input(error),
            ScheduleError::Log(error) => Self::Log(error),
        }
    }
}

/// An update request (TYP:340-381): the binding, the complete observed record, and what to change.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateRequest {
    /// The session the task must belong to.
    pub session_id: String,
    /// The task.
    pub id: String,
    /// The complete record the caller observed.
    pub expected: Value,
    /// A new title, as supplied.
    pub title: Option<Value>,
    /// A new prompt, as supplied.
    pub prompt: Option<Value>,
    /// One timing change `{kind, <selector>}`.
    pub change: Option<Value>,
}

/// What an update gives: the resolution, or a lookup miss.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateResult {
    /// The compare-and-set resolution (including the subagent refusal).
    Resolved(UpdateResolution),
    /// `{id, updated: false, code: "schedule_not_found"}`.
    NotFound {
        /// The task asked for.
        id: String,
    },
    /// `{id, updated: false, code: "schedule_ended"}`.
    Ended {
        /// The task asked for.
        id: String,
    },
}

impl UpdateResult {
    /// The value DSH answers.
    pub fn to_value(&self) -> Value {
        let miss = |id: &str, code: &str| {
            let mut map = Map::new();
            map.insert("id".into(), Value::from(id));
            map.insert("updated".into(), Value::from(false));
            map.insert("code".into(), Value::from(code));
            Value::Object(map)
        };
        match self {
            Self::Resolved(resolution) => resolution.to_value(),
            Self::NotFound { id } => miss(id, "schedule_not_found"),
            Self::Ended { id } => miss(id, "schedule_ended"),
        }
    }
}

/// What a delete gives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeleteResult {
    /// The task asked for.
    pub id: String,
    /// Whether it was removed; `false` is `schedule_not_found`.
    pub deleted: bool,
}

impl DeleteResult {
    /// `{id, deleted: true}` or `{id, deleted: false, code: "schedule_not_found"}`.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.clone()));
        map.insert("deleted".into(), Value::from(self.deleted));
        if !self.deleted {
            map.insert("code".into(), Value::from("schedule_not_found"));
        }
        Value::Object(map)
    }
}

/// A history page request: the binding, the task, a page size of 1-100 and an exclusive message cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRequest {
    /// The session the task must belong to.
    pub session_id: String,
    /// The task.
    pub id: String,
    /// 1-100; anything else is refused.
    pub limit: i64,
    /// An exclusive message cursor.
    pub before: Option<String>,
}

/// One history page, newest first, or a lookup miss.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryResult {
    /// A page.
    Page {
        /// The task.
        id: String,
        /// Newest first.
        records: Vec<DeliveryRecord>,
        /// Whether deliveries before the retained ones are unavailable.
        earlier_records_unavailable: bool,
        /// Whether retention removed some.
        earlier_records_pruned: bool,
        /// The bounds.
        retention: ScheduleRetention,
        /// The cursor of the next older page.
        next_before: Option<String>,
    },
    /// `{id, code}`: `schedule_not_found` or `delivery_cursor_not_found`.
    Miss {
        /// The task asked for.
        id: String,
        /// The code.
        code: &'static str,
    },
}

impl HistoryResult {
    /// The value DSH answers, in its key order.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        match self {
            Self::Page {
                id,
                records,
                earlier_records_unavailable,
                earlier_records_pruned,
                retention,
                next_before,
            } => {
                map.insert("id".into(), Value::from(id.clone()));
                map.insert(
                    "records".into(),
                    Value::Array(records.iter().map(DeliveryRecord::to_value).collect()),
                );
                map.insert(
                    "earlierRecordsUnavailable".into(),
                    Value::from(*earlier_records_unavailable),
                );
                map.insert("earlierRecordsPruned".into(), Value::from(*earlier_records_pruned));
                map.insert("retention".into(), retention.to_value());
                if let Some(cursor) = next_before {
                    map.insert("nextBefore".into(), Value::from(cursor.clone()));
                }
            }
            Self::Miss { id, code } => {
                map.insert("id".into(), Value::from(id.clone()));
                map.insert("code".into(), Value::from(*code));
            }
        }
        Value::Object(map)
    }
}

/// One catalog row: the record plus its binding, status and last delivery.
pub fn catalog_entry(task: &ScheduleTask) -> Value {
    let mut map = task.record.to_map();
    map.insert("sessionId".into(), Value::from(task.session_id.clone()));
    map.insert("status".into(), Value::from(task.status.as_str()));
    if let Some(receipt) = &task.last_delivery {
        map.insert("lastDelivery".into(), Value::Object(receipt.to_map()));
    }
    Value::Object(map)
}

/// What the service needs from a delivery driver.
pub trait ScheduleDriverHandle: Send + Sync {
    /// Look again at the table.
    fn request_drive(&self);
    /// Begin delivering.
    fn start(&self);
}

/// The delivery history a task without one exposes: only its last receipt, with earlier records unavailable.
pub fn delivery_history_of(task: &ScheduleTask) -> DeliveryHistory {
    task.delivery_history.clone().unwrap_or_else(|| DeliveryHistory {
        records: task
            .last_delivery
            .iter()
            .map(|receipt| DeliveryRecord {
                receipt: receipt.clone(),
                prompt: None,
            })
            .collect(),
        earlier_records_unavailable: true,
        earlier_records_pruned: None,
    })
}

/// Append one acknowledged delivery and prune (SVC:1445-1461): keep records delivered within the window before
/// the new one, then the last N; either cut marks earlier records unavailable **and** pruned.
pub fn append_delivery(
    task: &ScheduleTask,
    receipt: DeliveryReceipt,
    bounds: ScheduleRetention,
) -> (DeliveryReceipt, DeliveryHistory) {
    let history = delivery_history_of(task);
    let mut appended = history.records.clone();
    appended.push(DeliveryRecord {
        receipt: receipt.clone(),
        prompt: Some(task.record.prompt.clone()),
    });
    let delivered = |record: &DeliveryRecord| parse_instant(&record.receipt.delivered_at).unwrap_or(i64::MIN);
    let floor = delivered(appended.last().expect("one was appended")) - bounds.days * DAY_MS;
    let within: Vec<DeliveryRecord> = appended
        .iter()
        .filter(|record| delivered(record) >= floor)
        .cloned()
        .collect();
    let cap = usize::try_from(bounds.records).unwrap_or(usize::MAX);
    let retained: Vec<DeliveryRecord> = within[within.len().saturating_sub(cap)..].to_vec();
    let dropped = retained.len() != appended.len();
    (
        receipt,
        DeliveryHistory {
            records: retained,
            earlier_records_unavailable: history.earlier_records_unavailable || dropped,
            earlier_records_pruned: Some(history.earlier_records_pruned == Some(true) || dropped),
        },
    )
}

fn bounded(value: Option<i64>, fallback: i64, max: i64, name: &str) -> Result<i64, OpenError> {
    let resolved = value.unwrap_or(fallback);
    if !(1..=max).contains(&resolved) {
        return Err(OpenError::Retention(format!(
            "{name} must be an integer from 1 through {max}"
        )));
    }
    Ok(resolved)
}

/// The one queue every write waits in. A ticket is taken when an operation is called; the operation runs when
/// every earlier ticket is done or abandoned.
#[derive(Default)]
pub(crate) struct Fifo {
    state: Mutex<FifoState>,
    notify: tokio::sync::Notify,
}

#[derive(Default)]
struct FifoState {
    next: u64,
    serving: u64,
    abandoned: BTreeSet<u64>,
    stopping: bool,
}

/// One place in the queue. Dropping it, done or not, lets the queue move on.
pub(crate) struct Ticket<'a> {
    fifo: &'a Fifo,
    number: u64,
}

impl Fifo {
    fn state(&self) -> std::sync::MutexGuard<'_, FifoState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A place at the back of the queue, or `None` once the queue is stopping.
    fn ticket(&self) -> Option<Ticket<'_>> {
        let mut state = self.state();
        if state.stopping {
            return None;
        }
        let number = state.next;
        state.next += 1;
        Some(Ticket { fifo: self, number })
    }

    async fn until(&self, done: impl Fn(&FifoState) -> bool) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if done(&self.state()) {
                return;
            }
            notified.await;
        }
    }

    /// Stop issuing tickets and wait for every issued one.
    async fn drain(&self) {
        self.state().stopping = true;
        self.until(|state| state.serving >= state.next).await;
    }
}

impl Ticket<'_> {
    async fn ready(&self) {
        let number = self.number;
        self.fifo.until(|state| state.serving == number).await;
    }
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        let mut state = self.fifo.state();
        if state.serving == self.number {
            state.serving += 1;
            loop {
                let serving = state.serving;
                if !state.abandoned.remove(&serving) {
                    break;
                }
                state.serving += 1;
            }
        } else {
            state.abandoned.insert(self.number);
        }
        drop(state);
        self.fifo.notify.notify_waiters();
    }
}

/// The schedule service.
pub struct ScheduleService {
    store: ScheduleStore,
    retention: ScheduleRetention,
    clock: Clock,
    is_delegated: IsDelegated,
    warn: Warn,
    new_id: Arc<dyn Fn() -> String + Send + Sync>,
    listeners: Mutex<Vec<(u64, ChangeListener)>>,
    next_listener: AtomicU64,
    fifo: Fifo,
    driver: Mutex<Option<Weak<dyn ScheduleDriverHandle>>>,
}

fn system_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn aborted(cancel: &Option<CancellationToken>) -> bool {
    cancel.as_ref().is_some_and(CancellationToken::is_cancelled)
}

impl ScheduleService {
    /// Open the store; a corrupt file is an error here, which is what refuses startup.
    pub fn new(options: ScheduleServiceOptions) -> Result<Self, OpenError> {
        let retention = ScheduleRetention {
            days: bounded(options.retention_days, DEFAULT_DELIVERY_HISTORY_DAYS, 3650, "deliveryHistoryDays")?,
            records: bounded(
                options.retention_records,
                DEFAULT_DELIVERY_HISTORY_RECORDS,
                10_000,
                "deliveryHistoryRecords",
            )?,
        };
        let store = ScheduleStore::open(options.file).map_err(OpenError::Store)?;
        Ok(Self {
            store,
            retention,
            clock: options.now.unwrap_or_else(|| Arc::new(system_now)),
            is_delegated: options.is_delegated.unwrap_or_else(|| Arc::new(|_| false)),
            warn: options.warn.unwrap_or_else(|| Arc::new(|_| ())),
            new_id: options
                .new_id
                .unwrap_or_else(|| Arc::new(|| format!("schedule-{}", uuid::Uuid::new_v4()))),
            listeners: Mutex::new(Vec::new()),
            next_listener: AtomicU64::new(0),
            fifo: Fifo::default(),
            driver: Mutex::new(None),
        })
    }

    /// The store.
    pub fn store(&self) -> &ScheduleStore {
        &self.store
    }

    /// The retention bounds.
    pub fn retention(&self) -> ScheduleRetention {
        self.retention
    }

    /// The service's clock, which the tools and the driver share.
    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Report a contained failure.
    pub fn warn(&self, message: &str) {
        (self.warn)(message);
    }

    /// Create a reminder bound to a session (SVC:2083-2114). The record is built from a clock reading taken
    /// **before** the request joins the queue; a delegated child's session is refused inside the queue.
    pub fn create(
        &self,
        session_id: &str,
        request: &Map<String, Value>,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'_, Result<ScheduleRecord, ServiceError>> {
        let prepared = self.prepare_create(request);
        let ticket = if prepared.is_ok() {
            self.fifo.ticket()
        } else {
            None
        };
        let session_id = session_id.to_owned();
        Box::pin(async move {
            let record = prepared?;
            let ticket = ticket.ok_or(ServiceError::Stopping)?;
            ticket.ready().await;
            if (self.is_delegated)(&session_id) {
                return Err(ServiceError::Input(ScheduleInputError::new(
                    ScheduleErrorCode::SubagentSession,
                    SUBAGENT_TARGET_MESSAGE,
                )));
            }
            if aborted(&cancel) {
                return Err(ServiceError::Aborted);
            }
            self.store
                .put(&record.id, ScheduleTask::new(session_id, record.clone()))
                .map_err(ServiceError::Store)?;
            self.committed();
            drop(ticket);
            Ok(record)
        })
    }

    fn prepare_create(&self, request: &Map<String, Value>) -> Result<ScheduleRecord, ServiceError> {
        let selector_error = || {
            ServiceError::Input(ScheduleInputError::new(
                ScheduleErrorCode::InvalidSelector,
                "Exactly one reminder selector is required.",
            ))
        };
        let selectors = ["at", "after_seconds", "every_seconds", "daily", "weekly", "cron"]
            .iter()
            .filter(|key| request.contains_key(**key))
            .count();
        if selectors > 1 {
            return Err(selector_error());
        }
        let null = Value::Null;
        let title = Value::from(schedule_title(request.get("title").unwrap_or(&null))?);
        let id = (self.new_id)();
        let now = self.now();
        let prompt = request.get("prompt").unwrap_or(&null);
        let created = if let Some(at) = request.get("at") {
            create_at_schedule_record(&id, prompt, at, now, &title)
        } else if let Some(seconds) = request.get("after_seconds") {
            create_after_schedule_record(&id, prompt, seconds, now, &title)
        } else if let Some(seconds) = request.get("every_seconds") {
            create_every_schedule_record(&id, prompt, seconds, now, &title)
        } else if let Some(daily) = request.get("daily") {
            create_daily_schedule_record(&id, prompt, daily, now, &title)
        } else if let Some(weekly) = request.get("weekly") {
            create_weekly_schedule_record(&id, prompt, weekly, now, &title)
        } else if let Some(cron) = request.get("cron") {
            create_cron_schedule_record(&id, prompt, cron, now, &title)
        } else {
            return Err(selector_error());
        };
        Ok(created?)
    }

    /// The session's active records, in storage order (SVC:2120-2122).
    pub fn list(&self, session_id: &str) -> Vec<ScheduleRecord> {
        self.store
            .entries()
            .into_iter()
            .filter(|task| task.session_id == session_id && task.status == TaskStatus::Active)
            .map(|task| task.record)
            .collect()
    }

    /// Every row, active and inactive, with its binding — by scheduledAt, then id (SVC:2129-2136).
    pub fn catalog(&self) -> Vec<ScheduleTask> {
        let mut tasks = self.store.entries();
        tasks.sort_by(|left, right| {
            left.record
                .scheduled_at
                .cmp(&right.record.scheduled_at)
                .then_with(|| left.record.id.cmp(&right.record.id))
        });
        tasks
    }

    /// One page of a task's saved deliveries, newest first, before an exclusive message cursor
    /// (SVC:2144-2152, 1469-1490).
    pub fn history(&self, request: &HistoryRequest) -> Result<HistoryResult, ScheduleInputError> {
        if !js::is_safe(request.limit) || !(1..=100).contains(&request.limit) {
            return Err(ScheduleInputError::rule(
                "Delivery history limit must be a safe integer from 1 through 100.",
            ));
        }
        let miss = |code| HistoryResult::Miss {
            id: request.id.clone(),
            code,
        };
        let Some(task) = self
            .store
            .get(&request.id)
            .filter(|task| task.session_id == request.session_id)
        else {
            return Ok(miss("schedule_not_found"));
        };
        let history = delivery_history_of(&task);
        let end = match &request.before {
            None => history.records.len(),
            Some(cursor) => match history
                .records
                .iter()
                .position(|record| &record.receipt.message_id == cursor)
            {
                Some(index) => index,
                None => return Ok(miss("delivery_cursor_not_found")),
            },
        };
        let start = end.saturating_sub(request.limit as usize);
        let records: Vec<DeliveryRecord> = history.records[start..end].iter().rev().cloned().collect();
        let next_before = records
            .last()
            .filter(|_| start > 0)
            .map(|oldest| oldest.receipt.message_id.clone());
        Ok(HistoryResult::Page {
            id: request.id.clone(),
            records,
            earlier_records_unavailable: history.earlier_records_unavailable,
            earlier_records_pruned: history.earlier_records_pruned == Some(true),
            retention: self.retention,
            next_before,
        })
    }

    /// Delete one task of the session, in any state, with its history (SVC:2164-2182).
    pub fn delete(
        &self,
        session_id: &str,
        id: &str,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'_, Result<DeleteResult, ServiceError>> {
        let ticket = self.fifo.ticket();
        let session_id = session_id.to_owned();
        let id = id.to_owned();
        Box::pin(async move {
            let ticket = ticket.ok_or(ServiceError::Stopping)?;
            ticket.ready().await;
            if aborted(&cancel) {
                return Err(ServiceError::Aborted);
            }
            let found = self
                .store
                .get(&id)
                .is_some_and(|task| task.session_id == session_id);
            if !found {
                return Ok(DeleteResult { id, deleted: false });
            }
            self.store.delete(&id).map_err(ServiceError::Store)?;
            self.committed();
            drop(ticket);
            Ok(DeleteResult { id, deleted: true })
        })
    }

    /// Change an active task's name, instruction or timing in place (SVC:2197-2224): sampled inside the queue;
    /// a delegated child's session is refused as a result; an inactive task is `schedule_ended`; anything else is
    /// the compare-and-set resolution. A no-op writes nothing.
    pub fn update(
        &self,
        request: UpdateRequest,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'_, Result<UpdateResult, ServiceError>> {
        let ticket = self.fifo.ticket();
        Box::pin(async move {
            let ticket = ticket.ok_or(ServiceError::Stopping)?;
            ticket.ready().await;
            if (self.is_delegated)(&request.session_id) {
                return Ok(UpdateResult::Resolved(UpdateResolution::Refused {
                    code: ScheduleErrorCode::SubagentSession.as_str().to_owned(),
                    message: SUBAGENT_TARGET_MESSAGE.to_owned(),
                }));
            }
            if aborted(&cancel) {
                return Err(ServiceError::Aborted);
            }
            let Some(current) = self
                .store
                .get(&request.id)
                .filter(|task| task.session_id == request.session_id)
            else {
                return Ok(UpdateResult::NotFound { id: request.id });
            };
            if current.status == TaskStatus::Inactive {
                return Ok(UpdateResult::Ended { id: request.id });
            }
            let resolution = resolve_schedule_update(
                &current.record,
                &request.expected,
                request.change.as_ref(),
                self.now(),
                UpdateContent {
                    title: request.title.as_ref(),
                    prompt: request.prompt.as_ref(),
                },
            )?;
            if let UpdateResolution::Record {
                updated: true,
                record,
                ..
            } = &resolution
            {
                self.store
                    .put(
                        &request.id,
                        ScheduleTask {
                            record: record.clone(),
                            ..current
                        },
                    )
                    .map_err(ServiceError::Store)?;
                self.committed();
            }
            drop(ticket);
            Ok(UpdateResult::Resolved(resolution))
        })
    }

    /// Remove every active task of one session inside the queue — the archive stop (SVC:2273-2292).
    pub fn stop_session_tasks(&self, session_id: &str) -> BoxFuture<'_, Result<(), ServiceError>> {
        let ticket = self.fifo.ticket();
        let session_id = session_id.to_owned();
        Box::pin(async move {
            let ticket = ticket.ok_or(ServiceError::Stopping)?;
            ticket.ready().await;
            let active: Vec<String> = self
                .store
                .entries()
                .into_iter()
                .filter(|task| task.session_id == session_id && task.status == TaskStatus::Active)
                .map(|task| task.record.id)
                .collect();
            let mut removed = false;
            let mut failure: Option<String> = None;
            for id in active {
                match self.store.delete(&id) {
                    Ok(_) => removed = true,
                    Err(error) => {
                        failure.get_or_insert(error);
                    }
                }
            }
            if removed {
                self.committed();
            }
            drop(ticket);
            failure.map_or(Ok(()), |error| Err(ServiceError::Store(error)))
        })
    }

    /// Listen for committed writes; the id removes the listener.
    pub fn on_change(&self, listener: ChangeListener) -> u64 {
        let id = self.next_listener.fetch_add(1, Ordering::SeqCst);
        self.listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((id, listener));
        id
    }

    /// Stop listening.
    pub fn remove_listener(&self, id: u64) {
        self.listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|(existing, _)| *existing != id);
    }

    /// Bind the delivery driver every committed management write asks to drive.
    pub fn attach_driver(&self, driver: Weak<dyn ScheduleDriverHandle>) {
        *self.driver.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(driver);
    }

    fn driver(&self) -> Option<Arc<dyn ScheduleDriverHandle>> {
        self.driver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .and_then(Weak::upgrade)
    }

    /// Start delivery, for a host that did not start it at load (`autoStart: false`).
    pub fn start_delivery(&self) {
        if let Some(driver) = self.driver() {
            driver.start();
        }
    }

    /// The table, in storage order — what a drive scans.
    pub fn tasks(&self) -> Vec<ScheduleTask> {
        self.store.entries()
    }

    /// Persist one acknowledged delivery and announce it; called by the driver inside its serialized drive.
    pub fn commit_delivery(&self, task: ScheduleTask) -> Result<(), String> {
        let id = task.record.id.clone();
        self.store.put(&id, task)?;
        self.emit_changed();
        Ok(())
    }

    /// Run one operation in the FIFO, after everything queued before it; refused once the service is stopping.
    pub fn serialize<'a, T, F>(&'a self, work: F) -> BoxFuture<'a, Result<T, ServiceError>>
    where
        T: Send + 'a,
        F: FnOnce() -> T + Send + 'a,
    {
        self.serialize_async(move || async move { work() })
    }

    /// [`serialize`](Self::serialize) for asynchronous work, which holds the queue until it settles.
    pub fn serialize_async<'a, T, F, Fut>(&'a self, work: F) -> BoxFuture<'a, Result<T, ServiceError>>
    where
        T: Send + 'a,
        F: FnOnce() -> Fut + Send + 'a,
        Fut: Future<Output = T> + Send + 'a,
    {
        let ticket = self.fifo.ticket();
        Box::pin(async move {
            let ticket = ticket.ok_or(ServiceError::Stopping)?;
            ticket.ready().await;
            let value = work().await;
            drop(ticket);
            Ok(value)
        })
    }

    /// Stop accepting operations and wait for the queue to drain.
    pub async fn dispose(&self) {
        self.fifo.drain().await;
    }

    /// After a committed management write: tell the listeners, then ask the driver to look again.
    fn committed(&self) {
        self.emit_changed();
        if let Some(driver) = self.driver() {
            driver.request_drive();
        }
    }

    /// A failing listener must not reject the caller whose write has already landed (SVC:2231-2237).
    fn emit_changed(&self) {
        let listeners: Vec<ChangeListener> = self
            .listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            if let Err(error) = listener() {
                self.warn(&format!("schedule: schedule/changed listener failed: {error}"));
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::tests::scratch;
    use serde_json::json;
    use std::sync::atomic::AtomicI64;

    /// 2026-10-29T12:00:00.000Z.
    pub(crate) const T0: i64 = 1_793_275_200_000;

    pub(crate) struct Setup {
        pub service: Arc<ScheduleService>,
        pub clock: Arc<AtomicI64>,
        pub file: PathBuf,
        pub changes: Arc<AtomicU64>,
        pub drives: Arc<CountingDriver>,
        pub warnings: Arc<Mutex<Vec<String>>>,
    }

    #[derive(Default)]
    pub(crate) struct CountingDriver {
        pub drives: AtomicU64,
    }

    impl ScheduleDriverHandle for CountingDriver {
        fn request_drive(&self) {
            self.drives.fetch_add(1, Ordering::SeqCst);
        }
        fn start(&self) {}
    }

    pub(crate) fn options(label: &str, clock: &Arc<AtomicI64>) -> ScheduleServiceOptions {
        let file = scratch(label).join("schedule.json");
        let ids = Arc::new(AtomicU64::new(0));
        let mut options = ScheduleServiceOptions::new(file);
        let reading = Arc::clone(clock);
        options.now = Some(Arc::new(move || reading.load(Ordering::SeqCst)));
        options.new_id = Some(Arc::new(move || format!("schedule-{}", ids.fetch_add(1, Ordering::SeqCst) + 1)));
        options
    }

    pub(crate) fn setup_with(label: &str, adjust: impl FnOnce(&mut ScheduleServiceOptions)) -> Setup {
        let clock = Arc::new(AtomicI64::new(T0));
        let mut options = options(label, &clock);
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&warnings);
        options.warn = Some(Arc::new(move |message: &str| sink.lock().unwrap().push(message.to_owned())));
        adjust(&mut options);
        let file = options.file.clone();
        let service = Arc::new(ScheduleService::new(options).unwrap());
        let changes = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&changes);
        service.on_change(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        let drives = Arc::new(CountingDriver::default());
        let handle: Arc<dyn ScheduleDriverHandle> = drives.clone();
        service.attach_driver(Arc::downgrade(&handle));
        Setup {
            service,
            clock,
            file,
            changes,
            drives,
            warnings,
        }
    }

    pub(crate) fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[track_caller]
    fn input_error<T: std::fmt::Debug>(result: Result<T, ServiceError>, code: &str, message: &str) {
        match result {
            Err(ServiceError::Input(error)) => {
                assert_eq!(error.code.as_str(), code);
                assert_eq!(error.message, message);
            }
            other => panic!("expected {code}, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_persists_an_active_row_with_empty_history_announces_it_and_asks_for_a_drive() {
        let setup = setup_with("svc-create", |_| ());
        let record = setup
            .service
            .create("session-1", &args(json!({"prompt": " Review ", "title": " Daily review ", "daily": {"time": "23:00:00", "time_zone": "Asia/Shanghai"}})), None)
            .await
            .unwrap();
        assert_eq!(
            record.to_value(),
            json!({"id": "schedule-1", "kind": "daily", "title": "Daily review", "prompt": "Review", "time": "23:00:00.000", "timeZone": "Asia/Shanghai", "scheduledAt": "2026-10-29T15:00:00.000Z"})
        );
        assert_eq!(ScheduleStore::open(&setup.file).unwrap().entries(), [ScheduleTask::new("session-1", record)]);
        assert_eq!(setup.changes.load(Ordering::SeqCst), 1);
        assert_eq!(setup.drives.drives.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn create_needs_exactly_one_selector_and_validates_before_it_queues() {
        let setup = setup_with("svc-selector", |_| ());
        let service = &setup.service;
        input_error(service.create("s", &args(json!({"prompt": "p", "title": "t"})), None).await, "invalid_selector", "Exactly one reminder selector is required.");
        input_error(service.create("s", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60, "every_seconds": 60})), None).await, "invalid_selector", "Exactly one reminder selector is required.");
        input_error(service.create("s", &args(json!({"prompt": "p", "title": " ", "after_seconds": 60})), None).await, "invalid_prompt", "title is required and must be non-empty after trimming.");
        input_error(service.create("s", &args(json!({"prompt": "p", "title": "t", "at": "2026-10-29T11:00:00Z"})), None).await, "not_future", "The scheduled time must be strictly in the future.");
        assert_eq!(setup.changes.load(Ordering::SeqCst), 0, "nothing was committed");
    }

    #[tokio::test]
    async fn create_samples_its_clock_before_queueing_update_samples_inside_the_queue() {
        let setup = setup_with("svc-clock", |_| ());
        let service = &setup.service;
        let first = service.create("s", &args(json!({"prompt": "p", "title": "t", "every_seconds": 60})), None).await.unwrap();
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let blocker = service.serialize_async(move || async move {
            let _ = held.await;
        });
        let created = service.create("s", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60})), None);
        let updated = service.update(
            UpdateRequest {
                session_id: "s".into(),
                id: first.id.clone(),
                expected: first.to_value(),
                title: None,
                prompt: None,
                change: Some(json!({"kind": "every", "every_seconds": 120})),
            },
            None,
        );
        setup.clock.store(T0 + 30_000, Ordering::SeqCst);
        release.send(()).unwrap();
        let (_, created, updated) = tokio::join!(blocker, created, updated);
        assert_eq!(created.unwrap().scheduled_at, "2026-10-29T12:01:00.000Z", "anchored at the request");
        let UpdateResult::Resolved(UpdateResolution::Record { record, .. }) = updated.unwrap() else {
            panic!("a record");
        };
        assert_eq!(record.scheduled_at, "2026-10-29T12:02:30.000Z", "anchored at the save, T0 + 30s + 120s");
    }

    #[tokio::test]
    async fn operations_run_in_fifo_order() {
        let setup = setup_with("svc-fifo", |_| ());
        let service = &setup.service;
        let seen = Mutex::new(Vec::new());
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let blocker = service.serialize_async(move || async move {
            let _ = held.await;
        });
        let a = service.serialize(|| seen.lock().unwrap().push(service.tasks().len()));
        let b = service.create("s", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60})), None);
        let c = service.serialize(|| seen.lock().unwrap().push(service.tasks().len()));
        release.send(()).unwrap();
        let (_, a, b, c) = tokio::join!(blocker, c, b, a);
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        assert_eq!(*seen.lock().unwrap(), [0, 1], "work queued before the create sees no row; after it, the row");
    }

    #[tokio::test]
    async fn list_is_the_sessions_active_rows_catalog_is_every_row_sorted_by_target_then_id() {
        let setup = setup_with("svc-list", |_| ());
        let service = &setup.service;
        let later = service.create("s1", &args(json!({"prompt": "p", "title": "later", "after_seconds": 600})), None).await.unwrap();
        let sooner = service.create("s1", &args(json!({"prompt": "p", "title": "sooner", "after_seconds": 60})), None).await.unwrap();
        let other = service.create("s2", &args(json!({"prompt": "p", "title": "other", "after_seconds": 60})), None).await.unwrap();
        let ids = |records: Vec<ScheduleRecord>| records.into_iter().map(|record| record.id).collect::<Vec<_>>();
        assert_eq!(ids(service.list("s1")), [later.id.clone(), sooner.id.clone()]);
        let catalog: Vec<Value> = service.catalog().iter().map(catalog_entry).collect();
        let catalog_ids: Vec<&str> = catalog.iter().map(|entry| entry["id"].as_str().unwrap()).collect();
        assert_eq!(catalog_ids, [sooner.id.as_str(), other.id.as_str(), later.id.as_str()], "equal targets order by id");
        let keys: Vec<&String> = catalog[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "kind", "title", "prompt", "afterSeconds", "scheduledAt", "sessionId", "status"]);
        let receipt = DeliveryReceipt { scheduled_at: sooner.scheduled_at.clone(), delivered_at: "2026-10-29T12:01:00.000Z".into(), message_id: "message-1".into() };
        service
            .commit_delivery(ScheduleTask {
                session_id: "s1".into(),
                record: sooner.clone(),
                status: TaskStatus::Inactive,
                last_delivery: Some(receipt.clone()),
                delivery_history: Some(DeliveryHistory { records: vec![DeliveryRecord { receipt, prompt: Some("p".into()) }], earlier_records_unavailable: false, earlier_records_pruned: None }),
            })
            .unwrap();
        assert_eq!(ids(service.list("s1")), std::slice::from_ref(&later.id), "an inactive row leaves the list");
        let inactive = service.catalog().into_iter().find(|task| task.record.id == sooner.id).unwrap();
        assert_eq!(inactive.status, TaskStatus::Inactive, "and stays in the catalog");
        assert_eq!(catalog_entry(&inactive)["lastDelivery"]["messageId"], "message-1");
    }

    fn request(session: &str, id: &str, expected: Value, title: Option<&str>, change: Option<Value>) -> UpdateRequest {
        UpdateRequest {
            session_id: session.into(),
            id: id.into(),
            expected,
            title: title.map(Value::from),
            prompt: None,
            change,
        }
    }

    #[tokio::test]
    async fn update_conflict_not_found_and_ended() {
        let setup = setup_with("svc-cas", |_| ());
        let service = &setup.service;
        let record = service.create("s1", &args(json!({"prompt": "p", "title": "t", "every_seconds": 60})), None).await.unwrap();
        let before = setup.changes.load(Ordering::SeqCst);
        let mut stale = record.to_value();
        stale["prompt"] = json!("stale");
        let value = |result: Result<UpdateResult, ServiceError>| result.unwrap().to_value();
        assert_eq!(value(service.update(request("s1", &record.id, stale, Some("new"), None), None).await), json!({"id": record.id, "updated": false, "code": "schedule_conflict"}));
        assert_eq!(value(service.update(request("s2", &record.id, record.to_value(), Some("new"), None), None).await), json!({"id": record.id, "updated": false, "code": "schedule_not_found"}));
        assert_eq!(value(service.update(request("s1", "schedule-x", record.to_value(), Some("new"), None), None).await), json!({"id": "schedule-x", "updated": false, "code": "schedule_not_found"}));
        assert_eq!(setup.changes.load(Ordering::SeqCst), before, "no miss writes anything");
        let task = service.tasks().remove(0);
        service.commit_delivery(ScheduleTask { status: TaskStatus::Inactive, ..task }).unwrap();
        assert_eq!(value(service.update(request("s1", &record.id, record.to_value(), Some("new"), None), None).await), json!({"id": record.id, "updated": false, "code": "schedule_ended"}));
    }

    #[tokio::test]
    async fn update_a_committed_change_is_persisted_and_announced_a_no_op_writes_nothing() {
        let setup = setup_with("svc-update", |_| ());
        let service = &setup.service;
        let record = service.create("s1", &args(json!({"prompt": "p", "title": "t", "every_seconds": 60})), None).await.unwrap();
        let (changes, drives) = (setup.changes.load(Ordering::SeqCst), setup.drives.drives.load(Ordering::SeqCst));
        let noop = service.update(request("s1", &record.id, record.to_value(), None, Some(json!({"kind": "every", "every_seconds": 60}))), None).await.unwrap();
        assert_eq!(noop, UpdateResult::Resolved(UpdateResolution::Record { id: record.id.clone(), updated: false, record: record.clone() }));
        assert_eq!(setup.changes.load(Ordering::SeqCst), changes);
        let UpdateResult::Resolved(UpdateResolution::Record { updated: true, record: titled, .. }) =
            service.update(request("s1", &record.id, record.to_value(), Some("Renamed"), None), None).await.unwrap()
        else {
            panic!("an update");
        };
        assert_eq!(titled.scheduled_at, record.scheduled_at, "a title alone keeps the target");
        assert_eq!(ScheduleStore::open(&setup.file).unwrap().get(&record.id).unwrap().record.title, "Renamed");
        assert_eq!(setup.changes.load(Ordering::SeqCst), changes + 1);
        assert_eq!(setup.drives.drives.load(Ordering::SeqCst), drives + 1);
        assert_eq!(
            service.update(request("s1", &record.id, titled.to_value(), None, Some(json!({"kind": "every"}))), None).await.unwrap().to_value(),
            json!({"code": "invalid_rule", "message": "Timing change must contain exactly kind and its matching timing selector."})
        );
    }

    #[tokio::test]
    async fn a_delegated_childs_session_create_throws_and_update_returns_subagent_session() {
        let delegated = Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
        let reading = Arc::clone(&delegated);
        let setup = setup_with("svc-subagent", move |options| {
            options.is_delegated = Some(Arc::new(move |id: &str| reading.lock().unwrap().contains(id)));
        });
        let service = &setup.service;
        let record = service.create("child", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60})), None).await.unwrap();
        delegated.lock().unwrap().insert("child".into());
        input_error(
            service.create("child", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60})), None).await,
            "subagent_session",
            SUBAGENT_TARGET_MESSAGE,
        );
        assert_eq!(
            service.update(request("child", &record.id, record.to_value(), Some("x"), None), None).await.unwrap().to_value(),
            json!({"code": "subagent_session", "message": SUBAGENT_TARGET_MESSAGE})
        );
        assert_eq!(service.list("child").len(), 1);
        assert_eq!(service.delete("child", &record.id, None).await.unwrap(), DeleteResult { id: record.id, deleted: true });
    }

    #[tokio::test]
    async fn an_aborted_signal_is_checked_in_the_queue_before_anything_is_written() {
        let setup = setup_with("svc-abort", |_| ());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = setup.service.create("s", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60})), Some(cancel)).await;
        assert_eq!(result, Err(ServiceError::Aborted));
        assert!(setup.service.tasks().is_empty());
        assert_eq!(setup.changes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn delete_removes_the_row_and_its_history_from_any_state() {
        let setup = setup_with("svc-delete", |_| ());
        let service = &setup.service;
        let record = service.create("s1", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60})), None).await.unwrap();
        assert_eq!(service.delete("s2", &record.id, None).await.unwrap().to_value(), json!({"id": record.id, "deleted": false, "code": "schedule_not_found"}));
        let task = service.tasks().remove(0);
        service.commit_delivery(ScheduleTask { status: TaskStatus::Inactive, ..task }).unwrap();
        assert_eq!(service.delete("s1", &record.id, None).await.unwrap(), DeleteResult { id: record.id.clone(), deleted: true });
        let history = service.history(&HistoryRequest { session_id: "s1".into(), id: record.id.clone(), limit: 10, before: None }).unwrap();
        assert_eq!(history.to_value(), json!({"id": record.id, "code": "schedule_not_found"}));
        assert_eq!(
            serde_json::to_string(&service.delete("s1", &record.id, None).await.unwrap().to_value()).unwrap(),
            format!("{{\"id\":\"{}\",\"deleted\":false,\"code\":\"schedule_not_found\"}}", record.id)
        );
    }

    #[tokio::test]
    async fn the_archive_stop_removes_only_that_sessions_active_rows() {
        let setup = setup_with("svc-stop", |_| ());
        let service = &setup.service;
        service.create("s1", &args(json!({"prompt": "p", "title": "a", "after_seconds": 60})), None).await.unwrap();
        let kept = service.create("s2", &args(json!({"prompt": "p", "title": "b", "after_seconds": 60})), None).await.unwrap();
        service.stop_session_tasks("s1").await.unwrap();
        assert_eq!(service.tasks().into_iter().map(|task| task.record.id).collect::<Vec<_>>(), [kept.id]);
    }

    /// A task whose history holds `count` deliveries, one minute apart, ending at `end`.
    fn with_history(service: &ScheduleService, id: &str, count: i64, end: i64) {
        let task = service.tasks().into_iter().find(|task| task.record.id == id).unwrap();
        let mut current = task.clone();
        for index in 0..count {
            let delivered_at = crate::time::format_instant(end - (count - 1 - index) * 60_000);
            let receipt = DeliveryReceipt { scheduled_at: task.record.scheduled_at.clone(), delivered_at, message_id: format!("message-{index}") };
            let (last, history) = append_delivery(&current, receipt, service.retention());
            current.last_delivery = Some(last);
            current.delivery_history = Some(history);
        }
        service.commit_delivery(current).unwrap();
    }

    fn page(result: HistoryResult) -> (Vec<String>, bool, bool, Option<String>) {
        let HistoryResult::Page { records, earlier_records_unavailable, earlier_records_pruned, next_before, .. } = result else {
            panic!("a page");
        };
        (records.into_iter().map(|record| record.receipt.message_id).collect(), earlier_records_unavailable, earlier_records_pruned, next_before)
    }

    #[tokio::test]
    async fn history_newest_first_an_exclusive_cursor_next_before_and_lookup_misses() {
        let setup = setup_with("svc-history", |_| ());
        let service = &setup.service;
        let record = service.create("s1", &args(json!({"prompt": "p", "title": "t", "every_seconds": 60})), None).await.unwrap();
        let ask = |limit: i64, before: Option<&str>, session: &str| {
            service.history(&HistoryRequest { session_id: session.into(), id: record.id.clone(), limit, before: before.map(str::to_owned) })
        };
        for limit in [0, 101] {
            let error = ask(limit, None, "s1").unwrap_err();
            assert_eq!((error.code.as_str(), error.message.as_str()), ("invalid_rule", "Delivery history limit must be a safe integer from 1 through 100."));
        }
        with_history(service, &record.id, 5, T0);
        let first = ask(2, None, "s1").unwrap();
        assert!(matches!(&first, HistoryResult::Page { retention, .. } if *retention == ScheduleRetention { days: 30, records: 200 }));
        assert_eq!(page(first), (vec!["message-4".to_owned(), "message-3".to_owned()], false, false, Some("message-3".to_owned())));
        assert_eq!(page(ask(2, Some("message-3"), "s1").unwrap()).0, ["message-2", "message-1"]);
        let last = ask(2, Some("message-1"), "s1").unwrap();
        let keys: Vec<String> = last.to_value()["records"][0].as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["scheduledAt", "deliveredAt", "messageId", "prompt"]);
        assert_eq!(page(last), (vec!["message-0".to_owned()], false, false, None), "the first page has no older cursor");
        assert_eq!(ask(2, Some("message-x"), "s1").unwrap().to_value(), json!({"id": record.id, "code": "delivery_cursor_not_found"}));
        assert_eq!(ask(2, None, "s2").unwrap().to_value(), json!({"id": record.id, "code": "schedule_not_found"}));
    }

    #[tokio::test]
    async fn retention_prunes_by_the_day_window_and_by_the_record_cap_and_says_so() {
        let setup = setup_with("svc-retention", |options| {
            options.retention_days = Some(1);
            options.retention_records = Some(3);
        });
        let service = &setup.service;
        let record = service.create("s1", &args(json!({"prompt": "p", "title": "t", "every_seconds": 60})), None).await.unwrap();
        let ask = || service.history(&HistoryRequest { session_id: "s1".into(), id: record.id.clone(), limit: 100, before: None }).unwrap();
        with_history(service, &record.id, 3, T0);
        let (records, _, pruned, _) = page(ask());
        assert_eq!((records.len(), pruned), (3, false));
        with_history(service, &record.id, 1, T0 + 60_000);
        let (records, unavailable, pruned, _) = page(ask());
        assert_eq!((records.len(), unavailable, pruned), (3, true, true), "the cap keeps the last three");

        let task = service.tasks().remove(0);
        let receipt = |delivered: i64, id: &str| DeliveryReceipt { scheduled_at: task.record.scheduled_at.clone(), delivered_at: crate::time::format_instant(delivered), message_id: id.into() };
        let (_, pruned) = append_delivery(&task, receipt(T0 + 2 * DAY_MS, "late"), ScheduleRetention { days: 1, records: 10 });
        assert_eq!(pruned.records.iter().map(|one| one.receipt.message_id.as_str()).collect::<Vec<_>>(), ["late"], "older than the window goes");
        let legacy = ScheduleTask { session_id: "s".into(), record: task.record.clone(), status: TaskStatus::Active, last_delivery: Some(receipt(T0, "old")), delivery_history: None };
        let (_, from_legacy) = append_delivery(&legacy, receipt(T0 + 1000, "new"), ScheduleRetention { days: 30, records: 200 });
        assert!(from_legacy.earlier_records_unavailable, "a row without history exposes only its last delivery");
        assert_eq!(from_legacy.records.iter().map(|one| one.receipt.message_id.as_str()).collect::<Vec<_>>(), ["old", "new"]);
    }

    #[tokio::test]
    async fn retention_bounds_are_checked_a_failing_listener_is_contained_a_stopped_service_refuses_work() {
        let clock = Arc::new(AtomicI64::new(T0));
        let mut bad = options("svc-bounds", &clock);
        bad.retention_days = Some(0);
        assert_eq!(ScheduleService::new(bad).err().unwrap().to_string(), "deliveryHistoryDays must be an integer from 1 through 3650");
        let mut bad = options("svc-bounds", &clock);
        bad.retention_records = Some(10_001);
        assert_eq!(ScheduleService::new(bad).err().unwrap().to_string(), "deliveryHistoryRecords must be an integer from 1 through 10000");
        let setup = setup_with("svc-listener", |_| ());
        setup.service.on_change(Arc::new(|| Err("Error: listener broke".to_owned())));
        setup.service.create("s", &args(json!({"prompt": "p", "title": "t", "after_seconds": 60})), None).await.unwrap();
        assert_eq!(*setup.warnings.lock().unwrap(), ["schedule: schedule/changed listener failed: Error: listener broke"]);
        setup.service.dispose().await;
        let refused = setup.service.serialize(|| 1).await;
        assert_eq!(refused.unwrap_err().to_string(), "Schedule service is stopping");
    }
}
