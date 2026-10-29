//! Delivery (`src/schedule/delivery.ts`): when a reminder is due, its text becomes the user message of a turn in
//! the session it belongs to.
//!
//! A port of DSH's `ScheduleRuntime` (SVC:1493-1648) and its two message templates (SVC:1386-1418), over what heddle
//! has instead of DSH's agent inbox: an **idle** session gets a new turn whose prompt is the reminder text, and a
//! **busy** one is left until its turn ends — the driver records that it is waiting and drives again on the turn's
//! end (and, as a net, a minute later). The acknowledgement is the **session's own log**: a delivery commits only
//! once its message is found there.
//!
//! Everything else is DSH's: one timer to the earliest active target (clamped); a drive at start, on the timer and
//! after every committed management write; a one-shot is its own group and every due recurring task of a session
//! shares one batch message; each recurring task delivers only its **latest** missed occurrence; and each task is
//! committed separately, after the message, so a crash between the two redelivers (at least once).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde_json::{Map, Value};

use crate::js;
use crate::rules::{Occurrence, ScheduleRecord, resolve_recurring_occurrence};
use crate::service::{ScheduleDriverHandle, ScheduleService, Warn, append_delivery};
use crate::store::{DeliveryReceipt, ScheduleTask, TaskStatus};
use crate::time::format_instant;

/// The fixed origin line both templates carry.
pub const SCHEDULED_MESSAGE_FRAMING: &str = "This is a scheduled message from the user";

/// Largest delay a Node timer represents without clamping — kept so the timer's arithmetic is DSH's.
pub const MAX_TIMER_DELAY_MS: i64 = 2_147_483_647;

/// How long a reminder waiting on a busy session goes before the driver looks again without being told.
pub const BUSY_RECHECK_MS: i64 = 60_000;

/// The source a delivered reminder's user message carries: `{kind: "schedule"}`.
pub fn schedule_source() -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), Value::from("schedule"));
    Value::Object(map)
}

/// The one-shot template (SVC:1393-1401).
pub fn render_reminder_framing(record: &ScheduleRecord) -> String {
    [
        "[SCHEDULE REMINDER]".to_owned(),
        SCHEDULED_MESSAGE_FRAMING.to_owned(),
        format!("schedule_id_json: {}", js::json_string(&record.id)),
        format!("occurrence_at: {}", record.scheduled_at),
        format!("reminder_prompt_json: {}", js::json_string(&record.prompt)),
    ]
    .join("\n")
}

/// The recurring template, used even for a batch of one (SVC:1407-1418).
pub fn render_recurring_reminder_batch_framing(reminders: &[(&ScheduleRecord, &str)]) -> String {
    let payload: Vec<Value> = reminders
        .iter()
        .map(|(record, occurrence_at)| {
            let mut map = Map::new();
            map.insert("schedule_id".into(), Value::from(record.id.clone()));
            map.insert("occurrence_at".into(), Value::from(*occurrence_at));
            map.insert("reminder_prompt".into(), Value::from(record.prompt.clone()));
            Value::Object(map)
        })
        .collect();
    format!(
        "[SCHEDULE REMINDER BATCH]\n{SCHEDULED_MESSAGE_FRAMING}\nreminders_json: {}",
        serde_json::to_string(&payload).expect("a payload serializes")
    )
}

/// What delivery needs from the host: sessions, their busy state, a way to start a turn, and their logs. Every
/// `Err` is the sentence of the failure.
pub trait DeliveryHost: Send + Sync {
    /// Refuse a session that cannot receive a reminder — it is gone, or it is a delegated child's.
    fn resolve(&self, session_id: &str) -> Result<(), String>;
    /// Whether the session has a turn in flight right now.
    fn is_busy(&self, session_id: &str) -> bool;
    /// A cursor into the session's log; every event appended later is at or after it.
    fn cursor(&self, session_id: &str) -> usize;
    /// Start a turn whose user message is `text`, attributed by `source`. Resolves once started, not finished.
    fn start_turn(
        &self,
        session_id: &str,
        text: &str,
        source: Value,
    ) -> BoxFuture<'static, Result<(), String>>;
    /// Find that user message in the session's own log at or after `cursor`: the message id that proves it.
    fn find(&self, session_id: &str, cursor: usize, text: &str) -> Option<String>;
    /// Resolves once the session has no turn in flight, when the host can tell; `None` leaves the wake-up to
    /// [`ScheduleDriver::turn_ended`] and the busy recheck.
    fn when_idle(&self, session_id: &str) -> Option<BoxFuture<'static, ()>> {
        let _ = session_id;
        None
    }
}

/// An armed timer.
pub type TimerId = u64;
/// A timer's or a deferral's callback.
pub type Callback = Box<dyn FnOnce() + Send>;

/// How the driver waits: one timer at a time, and a deferral past the current turn of the runtime.
pub trait DriverTimers: Send + Sync {
    /// Arm a timer.
    fn set_timer(&self, delay_ms: u64, callback: Callback) -> TimerId;
    /// Disarm one; a fired or unknown id is ignored.
    fn clear_timer(&self, id: TimerId);
    /// Run a callback soon, after the caller has returned.
    fn defer(&self, callback: Callback);
}

/// [`DriverTimers`] on a tokio runtime.
pub struct TokioTimers {
    runtime: tokio::runtime::Handle,
    next: AtomicU64,
    armed: Arc<Mutex<HashMap<TimerId, tokio::task::AbortHandle>>>,
}

impl TokioTimers {
    /// Timers whose tasks run on `runtime`.
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self {
            runtime,
            next: AtomicU64::new(1),
            armed: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl DriverTimers for TokioTimers {
    fn set_timer(&self, delay_ms: u64, callback: Callback) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let armed = Arc::clone(&self.armed);
        let task = self.runtime.spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            armed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            callback();
        });
        self.armed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, task.abort_handle());
        id
    }

    fn clear_timer(&self, id: TimerId) {
        if let Some(task) = self
            .armed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&id)
        {
            task.abort();
        }
    }

    fn defer(&self, callback: Callback) {
        self.runtime.spawn(async move {
            tokio::task::yield_now().await;
            callback();
        });
    }
}

#[derive(Default)]
struct DriverState {
    timer: Option<TimerId>,
    running: Option<Shared<BoxFuture<'static, ()>>>,
    requested: bool,
    started: bool,
    stopping: bool,
    /// Sessions whose due reminders wait for the turn in flight to end.
    waiting: HashSet<String>,
}

/// What one group's delivery came to.
enum GroupOutcome {
    Deferred,
    Done,
}

/// The driver: at most one timer, one drive at a time, every drive inside the service's FIFO.
pub struct ScheduleDriver {
    service: Arc<ScheduleService>,
    host: Arc<dyn DeliveryHost>,
    timers: Arc<dyn DriverTimers>,
    busy_recheck_ms: i64,
    warn: Warn,
    runtime: Option<tokio::runtime::Handle>,
    state: Mutex<DriverState>,
    me: Weak<ScheduleDriver>,
}

/// How a driver is built.
#[derive(Default)]
pub struct DriverOptions {
    /// The timers; [`TokioTimers`] on the driver's runtime by default.
    pub timers: Option<Arc<dyn DriverTimers>>,
    /// The busy recheck; [`BUSY_RECHECK_MS`] by default.
    pub busy_recheck_ms: Option<i64>,
    /// Where a contained failure is reported; the service's own sink by default.
    pub warn: Option<Warn>,
    /// Where drives run; the caller's runtime when absent.
    pub runtime: Option<tokio::runtime::Handle>,
}

impl ScheduleDriver {
    /// A driver over `service` and `host`, attached to the service so its committed writes drive.
    pub fn new(
        service: Arc<ScheduleService>,
        host: Arc<dyn DeliveryHost>,
        options: DriverOptions,
    ) -> Arc<Self> {
        let runtime = options
            .runtime
            .or_else(|| tokio::runtime::Handle::try_current().ok());
        let timers: Arc<dyn DriverTimers> = match (options.timers, &runtime) {
            (Some(timers), _) => timers,
            (None, Some(runtime)) => Arc::new(TokioTimers::new(runtime.clone())),
            (None, None) => Arc::new(NoTimers),
        };
        let warn = options.warn.unwrap_or_else(|| {
            let service = Arc::clone(&service);
            Arc::new(move |message: &str| service.warn(message))
        });
        let driver = Arc::new_cyclic(|me| Self {
            service: Arc::clone(&service),
            host,
            timers,
            busy_recheck_ms: options.busy_recheck_ms.unwrap_or(BUSY_RECHECK_MS),
            warn,
            runtime,
            state: Mutex::new(DriverState::default()),
            me: me.clone(),
        });
        let handle: Arc<dyn ScheduleDriverHandle> = driver.clone();
        service.attach_driver(Arc::downgrade(&handle));
        driver
    }

    fn state(&self) -> std::sync::MutexGuard<'_, DriverState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Begin delivering: from now on committed writes drive, and the first drive runs at once. Idempotent.
    pub fn start(&self) {
        {
            let mut state = self.state();
            if state.started || state.stopping {
                return;
            }
            state.started = true;
        }
        self.request_drive();
    }

    /// Whether a session's reminders are waiting for its turn to end.
    pub fn is_waiting(&self, session_id: &str) -> bool {
        self.state().waiting.contains(session_id)
    }

    fn clear_timer_locked(&self, state: &mut DriverState) {
        if let Some(timer) = state.timer.take() {
            self.timers.clear_timer(timer);
        }
    }

    /// Recompute the nearest obligation (SVC:1524-1551). A request while a drive runs is folded into one more
    /// pass after it, so no edge is lost.
    pub fn request_drive(&self) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        let (sender, receiver) = futures::channel::oneshot::channel::<()>();
        {
            let mut state = self.state();
            if !state.started || state.stopping {
                return;
            }
            state.requested = true;
            self.clear_timer_locked(&mut state);
            if state.running.is_some() {
                return;
            }
            let Some(runtime) = self.runtime.clone() else {
                drop(state);
                (self.warn)("schedule: dispatch stopped: no async runtime to deliver on");
                return;
            };
            let settled: BoxFuture<'static, ()> = Box::pin(receiver.map(|_| ()));
            state.running = Some(settled.shared());
            runtime.spawn(async move {
                me.run(sender).await;
            });
        }
    }

    async fn run(self: Arc<Self>, sender: futures::channel::oneshot::Sender<()>) {
        loop {
            {
                let mut state = self.state();
                if !state.requested || state.stopping {
                    break;
                }
                state.requested = false;
            }
            let driver = Arc::clone(&self);
            let pass = self
                .service
                .serialize_async(move || async move { driver.drive().await })
                .await;
            if let Err(error) = pass {
                (self.warn)(&format!("schedule: dispatch stopped: Error: {error}"));
                break;
            }
        }
        let again = {
            let mut state = self.state();
            state.running = None;
            state.requested && !state.stopping
        };
        if again {
            self.request_drive();
        }
        let _ = sender.send(());
    }

    /// A session's turn ended. If its reminders were waiting, drive again — deferred, so the turn registry has
    /// settled the turn whose end this is.
    pub fn turn_ended(&self, session_id: &str) {
        if !self.state().waiting.remove(session_id) {
            return;
        }
        let me = self.me.clone();
        self.timers.defer(Box::new(move || {
            if let Some(driver) = me.upgrade() {
                driver.request_drive();
            }
        }));
    }

    /// Resolve once no drive is running and none is requested.
    pub async fn settled(&self) {
        loop {
            let running = self.state().running.clone();
            match running {
                Some(running) => running.await,
                None => return,
            }
        }
    }

    /// Stop the timer and drain the drive in flight.
    pub async fn dispose(&self) {
        let running = {
            let mut state = self.state();
            state.stopping = true;
            self.clear_timer_locked(&mut state);
            state.running.clone()
        };
        if let Some(running) = running {
            running.await;
        }
    }

    fn stopping(&self) -> bool {
        self.state().stopping
    }

    /// One drive (SVC:1562-1647), with heddle's busy-session wait.
    async fn drive(self: Arc<Self>) {
        {
            let mut state = self.state();
            self.clear_timer_locked(&mut state);
        }
        let mut failed: HashSet<String> = HashSet::new();
        let mut deferred: HashSet<String> = HashSet::new();
        let mut handled: HashSet<String> = HashSet::new();
        let scan_now = self.service.now();
        let due: Vec<ScheduleTask> = self
            .service
            .tasks()
            .into_iter()
            .filter(|task| {
                task.status == TaskStatus::Active && task.record.scheduled_ms() <= scan_now
            })
            .collect();
        for task in &due {
            if self.stopping() {
                return;
            }
            if handled.contains(&task.record.id) {
                continue;
            }
            let recurring = task.record.is_recurring();
            let group: Vec<ScheduleTask> = if recurring {
                due.iter()
                    .filter(|candidate| {
                        candidate.session_id == task.session_id && candidate.record.is_recurring()
                    })
                    .cloned()
                    .collect()
            } else {
                vec![task.clone()]
            };
            handled.extend(group.iter().map(|member| member.record.id.clone()));
            let mut admitted = group.clone();
            let mut committed: HashSet<String> = HashSet::new();
            let outcome = self
                .deliver_group(task, &group, recurring, &mut admitted, &mut committed)
                .await;
            match outcome {
                Ok(GroupOutcome::Deferred) => {
                    deferred.extend(group.iter().map(|member| member.record.id.clone()));
                }
                Ok(GroupOutcome::Done) => {}
                Err(error) => {
                    let pending: Vec<&ScheduleTask> = admitted
                        .iter()
                        .filter(|member| !committed.contains(&member.record.id))
                        .collect();
                    let failed_at = self.service.now();
                    for member in &pending {
                        if member.record.scheduled_ms() <= failed_at {
                            failed.insert(member.record.id.clone());
                        }
                    }
                    let ids: Vec<&str> = pending
                        .iter()
                        .map(|member| member.record.id.as_str())
                        .collect();
                    (self.warn)(&format!(
                        "schedule: reminders {} were not acknowledged: {error}",
                        serde_json::to_string(&ids).expect("ids serialize")
                    ));
                }
            }
        }
        if self.stopping() {
            return;
        }
        // The earliest active target, leaving out what failed in this drive (DSH) and what waits on a busy session.
        let mut next: Option<i64> = None;
        for task in self.service.tasks() {
            if task.status != TaskStatus::Active
                || failed.contains(&task.record.id)
                || deferred.contains(&task.record.id)
            {
                continue;
            }
            let target = task.record.scheduled_ms();
            next = Some(next.map_or(target, |current| current.min(target)));
        }
        if !deferred.is_empty() {
            let recheck = self.service.now() + self.busy_recheck_ms;
            next = Some(next.map_or(recheck, |current| current.min(recheck)));
        }
        if let Some(next) = next {
            let delay = (next - self.service.now()).clamp(0, MAX_TIMER_DELAY_MS) as u64;
            let me = self.me.clone();
            let cell: Arc<Mutex<Option<TimerId>>> = Arc::new(Mutex::new(None));
            let mine = Arc::clone(&cell);
            let id = self.timers.set_timer(
                delay,
                Box::new(move || {
                    let Some(driver) = me.upgrade() else {
                        return;
                    };
                    let fired = *mine.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    {
                        let mut state = driver.state();
                        if state.timer.is_some() && state.timer == fired {
                            state.timer = None;
                        }
                    }
                    driver.request_drive();
                }),
            );
            *cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id);
            self.state().timer = Some(id);
        }
    }

    /// One group: refuse, wait for a busy session, or deliver its message and commit each member.
    async fn deliver_group(
        &self,
        task: &ScheduleTask,
        group: &[ScheduleTask],
        recurring: bool,
        admitted: &mut Vec<ScheduleTask>,
        committed: &mut HashSet<String>,
    ) -> Result<GroupOutcome, String> {
        let session = task.session_id.as_str();
        self.host
            .resolve(session)
            .map_err(|error| format!("Error: {error}"))?;
        if self.host.is_busy(session) {
            // Heddle's followup: the reminder becomes the session's next turn, once the one in flight ends.
            let newly = self.state().waiting.insert(session.to_owned());
            if newly
                && let (Some(idle), Some(runtime)) =
                    (self.host.when_idle(session), self.runtime.clone())
            {
                let me = self.me.clone();
                let session = session.to_owned();
                runtime.spawn(async move {
                    idle.await;
                    if let Some(driver) = me.upgrade() {
                        driver.turn_ended(&session);
                    }
                });
            }
            return Ok(GroupOutcome::Deferred);
        }
        self.state().waiting.remove(session);
        let now = self.service.now();
        *admitted = group
            .iter()
            .filter(|member| member.record.scheduled_ms() <= now)
            .cloned()
            .collect();
        if admitted.is_empty() {
            return Ok(GroupOutcome::Done);
        }
        let mut occurrences: Vec<(ScheduleTask, Occurrence)> = Vec::new();
        for member in admitted.iter() {
            if let Some(decision) = resolve_recurring_occurrence(&member.record, now) {
                let occurrence = decision.map_err(|error| error.js_string())?;
                occurrences.push((member.clone(), occurrence));
            }
        }
        let text = if recurring {
            let reminders: Vec<(&ScheduleRecord, &str)> = occurrences
                .iter()
                .map(|(member, occurrence)| (&member.record, occurrence.occurrence_at.as_str()))
                .collect();
            render_recurring_reminder_batch_framing(&reminders)
        } else {
            render_reminder_framing(&task.record)
        };
        let cursor = self.host.cursor(session);
        self.host
            .start_turn(session, &text, schedule_source())
            .await
            .map_err(|error| format!("Error: {error}"))?;
        let message_id = self.host.find(session, cursor, &text).ok_or_else(|| {
            "Error: Session persistence did not acknowledge the reminder".to_owned()
        })?;
        let delivered_at = format_instant(self.service.now());
        let retention = self.service.retention();
        if !recurring {
            let receipt = DeliveryReceipt {
                scheduled_at: task.record.scheduled_at.clone(),
                delivered_at: delivered_at.clone(),
                message_id: message_id.clone(),
            };
            let (last, history) = append_delivery(task, receipt, retention);
            self.service
                .commit_delivery(ScheduleTask {
                    status: TaskStatus::Inactive,
                    last_delivery: Some(last),
                    delivery_history: Some(history),
                    ..task.clone()
                })
                .map_err(|error| format!("Error: {error}"))?;
            committed.insert(task.record.id.clone());
        }
        for (member, occurrence) in occurrences {
            let receipt = DeliveryReceipt {
                scheduled_at: occurrence.occurrence_at.clone(),
                delivered_at: delivered_at.clone(),
                message_id: message_id.clone(),
            };
            let (last, history) = append_delivery(&member, receipt, retention);
            let mut record = member.record.clone();
            record.scheduled_at = occurrence
                .next_scheduled_at
                .clone()
                .unwrap_or_else(|| occurrence.occurrence_at.clone());
            let id = member.record.id.clone();
            self.service
                .commit_delivery(ScheduleTask {
                    record,
                    status: if occurrence.next_scheduled_at.is_none() {
                        TaskStatus::Inactive
                    } else {
                        TaskStatus::Active
                    },
                    last_delivery: Some(last),
                    delivery_history: Some(history),
                    ..member
                })
                .map_err(|error| format!("Error: {error}"))?;
            committed.insert(id);
        }
        Ok(GroupOutcome::Done)
    }
}

impl ScheduleDriverHandle for ScheduleDriver {
    fn request_drive(&self) {
        ScheduleDriver::request_drive(self);
    }

    fn start(&self) {
        ScheduleDriver::start(self);
    }
}

/// Timers for a driver built outside any runtime: nothing is ever armed.
struct NoTimers;

impl DriverTimers for NoTimers {
    fn set_timer(&self, _delay_ms: u64, _callback: Callback) -> TimerId {
        0
    }

    fn clear_timer(&self, _id: TimerId) {}

    fn defer(&self, callback: Callback) {
        callback();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{ScheduleRule, create_after_schedule_record, create_daily_schedule_record};
    use crate::service::tests::{T0, args, options};
    use crate::service::{ScheduleService, ScheduleServiceOptions};
    use crate::store::ScheduleStore;
    use serde_json::json;
    use std::sync::atomic::AtomicI64;

    /// A session host whose logs are arrays and whose busy state a test sets.
    #[derive(Default)]
    struct FakeHost {
        logs: Mutex<HashMap<String, Vec<(String, String)>>>,
        busy: Mutex<HashSet<String>>,
        missing: Mutex<HashSet<String>>,
        started: Mutex<Vec<(String, String)>>,
        drop_writes: std::sync::atomic::AtomicBool,
    }

    impl FakeHost {
        fn idle(&self, session: &str, driver: &ScheduleDriver) {
            self.busy.lock().unwrap().remove(session);
            driver.turn_ended(session);
        }

        fn started(&self) -> Vec<(String, String)> {
            self.started.lock().unwrap().clone()
        }
    }

    impl DeliveryHost for FakeHost {
        fn resolve(&self, session_id: &str) -> Result<(), String> {
            if self.missing.lock().unwrap().contains(session_id) {
                return Err(format!("session \"{session_id}\" is not available"));
            }
            Ok(())
        }

        fn is_busy(&self, session_id: &str) -> bool {
            self.busy.lock().unwrap().contains(session_id)
        }

        fn cursor(&self, session_id: &str) -> usize {
            self.logs
                .lock()
                .unwrap()
                .get(session_id)
                .map_or(0, Vec::len)
        }

        fn start_turn(
            &self,
            session_id: &str,
            text: &str,
            source: Value,
        ) -> BoxFuture<'static, Result<(), String>> {
            self.started
                .lock()
                .unwrap()
                .push((session_id.to_owned(), text.to_owned()));
            if !self.drop_writes.load(Ordering::SeqCst) {
                self.logs
                    .lock()
                    .unwrap()
                    .entry(session_id.to_owned())
                    .or_default()
                    .push((
                        text.to_owned(),
                        source["kind"].as_str().unwrap_or("").to_owned(),
                    ));
            }
            self.busy.lock().unwrap().insert(session_id.to_owned());
            Box::pin(async { Ok(()) })
        }

        fn find(&self, session_id: &str, cursor: usize, text: &str) -> Option<String> {
            let logs = self.logs.lock().unwrap();
            let log = logs.get(session_id)?;
            log.iter()
                .enumerate()
                .position(|(at, (entry, kind))| at >= cursor && kind == "schedule" && entry == text)
                .map(|index| format!("message-{session_id}-{index}"))
        }
    }

    /// One armed fake timer: its id, its delay, its callback until fired, and whether it was cleared.
    type FakeTimer = (TimerId, u64, Option<Callback>, bool);

    /// One fake timer slot and a deferred-callback queue.
    #[derive(Default)]
    struct FakeTimers {
        current: Mutex<Option<FakeTimer>>,
        deferred: Mutex<Vec<Callback>>,
        next: AtomicU64,
    }

    impl FakeTimers {
        fn armed(&self) -> Option<u64> {
            match &*self.current.lock().unwrap() {
                Some((_, ms, _, false)) => Some(*ms),
                _ => None,
            }
        }

        fn fire(&self) {
            let callback = {
                let mut current = self.current.lock().unwrap();
                let slot = current.as_mut().expect("a timer is armed");
                assert!(!slot.3, "a timer is armed");
                slot.3 = true;
                slot.2.take().expect("the timer has its callback")
            };
            callback();
        }

        fn deferred_count(&self) -> usize {
            self.deferred.lock().unwrap().len()
        }

        fn flush_deferred(&self) {
            let callbacks: Vec<Callback> = self.deferred.lock().unwrap().drain(..).collect();
            for callback in callbacks {
                callback();
            }
        }
    }

    impl DriverTimers for FakeTimers {
        fn set_timer(&self, delay_ms: u64, callback: Callback) -> TimerId {
            let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
            *self.current.lock().unwrap() = Some((id, delay_ms, Some(callback), false));
            id
        }

        fn clear_timer(&self, id: TimerId) {
            if let Some(slot) = self.current.lock().unwrap().as_mut()
                && slot.0 == id
            {
                slot.3 = true;
            }
        }

        fn defer(&self, callback: Callback) {
            self.deferred.lock().unwrap().push(callback);
        }
    }

    struct Setup {
        service: Arc<ScheduleService>,
        clock: Arc<AtomicI64>,
        host: Arc<FakeHost>,
        timers: Arc<FakeTimers>,
        driver: Arc<ScheduleDriver>,
        warnings: Arc<Mutex<Vec<String>>>,
        changes: Arc<AtomicU64>,
    }

    fn setup(label: &str, seed: &[ScheduleTask], start: bool) -> Setup {
        let clock = Arc::new(AtomicI64::new(T0));
        let options: ScheduleServiceOptions = options(label, &clock);
        if !seed.is_empty() {
            let store = ScheduleStore::open(&options.file).unwrap();
            for task in seed {
                store.put(&task.record.id, task.clone()).unwrap();
            }
        }
        let service = Arc::new(ScheduleService::new(options).unwrap());
        let changes = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&changes);
        service.on_change(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        let host = Arc::new(FakeHost::default());
        let timers = Arc::new(FakeTimers::default());
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&warnings);
        let driver = ScheduleDriver::new(
            Arc::clone(&service),
            host.clone(),
            DriverOptions {
                timers: Some(timers.clone()),
                busy_recheck_ms: Some(60_000),
                warn: Some(Arc::new(move |message: &str| {
                    sink.lock().unwrap().push(message.to_owned())
                })),
                runtime: None,
            },
        );
        if start {
            driver.start();
        }
        Setup {
            service,
            clock,
            host,
            timers,
            driver,
            warnings,
            changes,
        }
    }

    fn task(record: ScheduleRecord, session: &str) -> ScheduleTask {
        ScheduleTask::new(session, record)
    }

    impl Setup {
        fn at(&self, offset: i64) {
            self.clock.store(T0 + offset, Ordering::SeqCst);
        }

        async fn create(&self, session: &str, value: Value) -> ScheduleRecord {
            self.service
                .create(session, &args(value), None)
                .await
                .unwrap()
        }
    }

    #[test]
    fn the_templates_are_dshs_with_json_escaped_dynamic_fields() {
        let record = create_after_schedule_record(
            "schedule-1",
            &json!("say \"hi\"\nthen stop"),
            &json!(60),
            T0,
            &json!("t"),
        )
        .unwrap();
        assert_eq!(
            render_reminder_framing(&record),
            "[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: \"schedule-1\"\noccurrence_at: 2026-10-29T12:01:00.000Z\nreminder_prompt_json: \"say \\\"hi\\\"\\nthen stop\""
        );
        assert_eq!(
            render_recurring_reminder_batch_framing(&[(&record, "2026-10-29T12:00:00.000Z")]),
            "[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [{\"schedule_id\":\"schedule-1\",\"occurrence_at\":\"2026-10-29T12:00:00.000Z\",\"reminder_prompt\":\"say \\\"hi\\\"\\nthen stop\"}]"
        );
    }

    #[tokio::test]
    async fn an_idle_session_gets_a_turn_with_the_one_shot_template_the_delivery_commits_after_the_proof()
     {
        let s = setup("dlv-idle", &[], true);
        s.create(
            "session-1",
            json!({"prompt": "check CI", "title": "CI", "after_seconds": 60}),
        )
        .await;
        s.driver.settled().await;
        assert_eq!(
            s.timers.armed(),
            Some(60_000),
            "one timer, to the earliest target"
        );
        assert!(s.host.started().is_empty());
        s.at(61_000);
        s.timers.fire();
        s.driver.settled().await;
        assert_eq!(
            s.host.started(),
            [("session-1".to_owned(), "[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: \"schedule-1\"\noccurrence_at: 2026-10-29T12:01:00.000Z\nreminder_prompt_json: \"check CI\"".to_owned())]
        );
        let stored = s.service.tasks().remove(0);
        assert_eq!(
            stored.status,
            TaskStatus::Inactive,
            "a delivered one-shot becomes inactive"
        );
        assert_eq!(
            stored
                .last_delivery
                .as_ref()
                .map(|receipt| receipt.to_map()),
            Some(args(
                json!({"scheduledAt": "2026-10-29T12:01:00.000Z", "deliveredAt": "2026-10-29T12:01:01.000Z", "messageId": "message-session-1-0"})
            ))
        );
        assert_eq!(
            stored.delivery_history.unwrap().to_value(),
            json!({"records": [{"scheduledAt": "2026-10-29T12:01:00.000Z", "deliveredAt": "2026-10-29T12:01:01.000Z", "messageId": "message-session-1-0", "prompt": "check CI"}], "earlierRecordsUnavailable": false, "earlierRecordsPruned": false})
        );
        assert_eq!(
            s.changes.load(Ordering::SeqCst),
            2,
            "the create and the delivery were each announced"
        );
        assert_eq!(s.timers.armed(), None, "nothing active is left to time");
    }

    #[tokio::test]
    async fn a_busy_session_waits_for_its_turn_to_end_then_the_reminder_is_its_next_turn() {
        let s = setup("dlv-busy", &[], true);
        s.create(
            "session-1",
            json!({"prompt": "p", "title": "t", "after_seconds": 60}),
        )
        .await;
        s.create(
            "session-2",
            json!({"prompt": "q", "title": "t", "after_seconds": 600}),
        )
        .await;
        s.driver.settled().await;
        s.host.busy.lock().unwrap().insert("session-1".into());
        s.at(60_000);
        s.timers.fire();
        s.driver.settled().await;
        assert!(
            s.host.started().is_empty(),
            "nothing is written into a running turn"
        );
        assert!(s.driver.is_waiting("session-1"));
        assert_eq!(s.service.tasks()[0].status, TaskStatus::Active);
        assert_eq!(
            s.timers.armed(),
            Some(60_000),
            "only the busy recheck and session-2 remain"
        );
        s.host.idle("session-2", &s.driver);
        assert_eq!(
            s.timers.deferred_count(),
            0,
            "another session ending is not this edge"
        );
        s.at(65_000);
        s.host.idle("session-1", &s.driver);
        assert!(
            s.host.started().is_empty(),
            "the drive is deferred past the turn that is completing"
        );
        s.timers.flush_deferred();
        s.driver.settled().await;
        assert_eq!(s.host.started().len(), 1);
        assert_eq!(s.host.started()[0].0, "session-1");
        assert_eq!(s.service.tasks()[0].status, TaskStatus::Inactive);
        assert_eq!(
            s.service.tasks()[0]
                .last_delivery
                .as_ref()
                .unwrap()
                .delivered_at,
            "2026-10-29T12:01:05.000Z"
        );
        assert!(!s.driver.is_waiting("session-1"));
    }

    #[tokio::test]
    async fn a_waiting_reminder_is_rechecked_when_no_turn_ended_edge_arrives() {
        let s = setup("dlv-recheck", &[], true);
        s.create(
            "session-1",
            json!({"prompt": "p", "title": "t", "after_seconds": 60}),
        )
        .await;
        s.driver.settled().await;
        s.host.busy.lock().unwrap().insert("session-1".into());
        s.at(60_000);
        s.timers.fire();
        s.driver.settled().await;
        assert_eq!(s.timers.armed(), Some(60_000), "the busy recheck");
        s.host.busy.lock().unwrap().remove("session-1");
        s.at(120_000);
        s.timers.fire();
        s.driver.settled().await;
        assert_eq!(s.host.started().len(), 1);
    }

    #[tokio::test]
    async fn a_delivery_that_cannot_be_proven_is_not_committed_is_logged_and_waits_for_the_next_drive()
     {
        let s = setup("dlv-proof", &[], true);
        s.create(
            "session-1",
            json!({"prompt": "p", "title": "t", "after_seconds": 60}),
        )
        .await;
        s.driver.settled().await;
        s.host.drop_writes.store(true, Ordering::SeqCst);
        s.at(60_000);
        s.timers.fire();
        s.driver.settled().await;
        assert_eq!(s.host.started().len(), 1, "the turn was attempted");
        assert_eq!(
            s.service.tasks()[0].status,
            TaskStatus::Active,
            "but nothing was committed"
        );
        assert_eq!(s.service.tasks()[0].last_delivery, None);
        assert_eq!(
            *s.warnings.lock().unwrap(),
            [
                "schedule: reminders [\"schedule-1\"] were not acknowledged: Error: Session persistence did not acknowledge the reminder"
            ]
        );
        assert_eq!(
            s.timers.armed(),
            None,
            "a failed reminder is left out of this drive's timer"
        );
        s.host.drop_writes.store(false, Ordering::SeqCst);
        s.host.busy.lock().unwrap().clear();
        s.create(
            "session-2",
            json!({"prompt": "q", "title": "t", "after_seconds": 600}),
        )
        .await;
        s.driver.settled().await;
        assert_eq!(
            s.service.tasks()[0].status,
            TaskStatus::Inactive,
            "any committed write drives again"
        );
    }

    #[tokio::test]
    async fn a_missing_session_is_a_warning_and_the_reminder_stays_due() {
        let s = setup("dlv-missing", &[], true);
        s.create(
            "session-gone",
            json!({"prompt": "p", "title": "t", "after_seconds": 60}),
        )
        .await;
        s.driver.settled().await;
        s.host.missing.lock().unwrap().insert("session-gone".into());
        s.at(60_000);
        s.timers.fire();
        s.driver.settled().await;
        assert_eq!(
            *s.warnings.lock().unwrap(),
            [
                "schedule: reminders [\"schedule-1\"] were not acknowledged: Error: session \"session-gone\" is not available"
            ]
        );
        assert_eq!(s.service.tasks()[0].status, TaskStatus::Active);
        assert!(s.host.started().is_empty());
    }

    fn every(id: &str, prompt: &str, seconds: i64, scheduled_at: &str) -> ScheduleRecord {
        ScheduleRecord {
            id: id.into(),
            title: "a".into(),
            prompt: prompt.into(),
            rule: ScheduleRule::Every {
                every_seconds: seconds,
            },
            scheduled_at: scheduled_at.into(),
        }
    }

    #[tokio::test]
    async fn after_downtime_recurring_reminders_of_a_session_share_one_batch_with_only_each_latest_occurrence()
     {
        let seed = [
            task(
                every("schedule-a", "ping a", 60, "2026-10-29T12:01:00.000Z"),
                "session-1",
            ),
            task(
                every("schedule-b", "ping b", 120, "2026-10-29T12:02:00.000Z"),
                "session-1",
            ),
            task(
                every("schedule-c", "ping c", 60, "2026-10-29T12:01:00.000Z"),
                "session-2",
            ),
        ];
        let s = setup("dlv-batch", &seed, false);
        s.at(630_000);
        s.driver.start();
        s.driver.settled().await;
        let started = s.host.started();
        assert_eq!(
            started
                .iter()
                .map(|(session, _)| session.as_str())
                .collect::<Vec<_>>(),
            ["session-1", "session-2"],
            "one message per session"
        );
        assert_eq!(
            started[0].1,
            "[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [{\"schedule_id\":\"schedule-a\",\"occurrence_at\":\"2026-10-29T12:10:00.000Z\",\"reminder_prompt\":\"ping a\"},{\"schedule_id\":\"schedule-b\",\"occurrence_at\":\"2026-10-29T12:10:00.000Z\",\"reminder_prompt\":\"ping b\"}]"
        );
        let tasks = s.service.tasks();
        let (a, b) = (&tasks[0], &tasks[1]);
        assert_eq!(
            a.record.scheduled_at, "2026-10-29T12:11:00.000Z",
            "the next target keeps the fixed-rate phase"
        );
        assert_eq!(b.record.scheduled_at, "2026-10-29T12:12:00.000Z");
        assert_eq!(a.status, TaskStatus::Active);
        assert_eq!(
            a.delivery_history.as_ref().unwrap().records.len(),
            1,
            "earlier missed occurrences leave no record"
        );
        assert_eq!(
            a.last_delivery.as_ref().unwrap().message_id,
            b.last_delivery.as_ref().unwrap().message_id,
            "a batch shares its message id"
        );
        assert_eq!(
            a.last_delivery.as_ref().unwrap().scheduled_at,
            "2026-10-29T12:10:00.000Z"
        );
    }

    #[tokio::test]
    async fn a_one_shot_is_never_batched_the_second_message_waits_for_the_first_turn() {
        let one_shot = create_after_schedule_record(
            "schedule-a",
            &json!("once"),
            &json!(60),
            T0,
            &json!("once"),
        )
        .unwrap();
        let daily = create_daily_schedule_record(
            "schedule-b",
            &json!("daily"),
            &json!({"time": "12:00:30", "time_zone": "UTC"}),
            T0,
            &json!("daily"),
        )
        .unwrap();
        let s = setup(
            "dlv-oneshot",
            &[task(one_shot, "session-1"), task(daily, "session-1")],
            false,
        );
        s.at(120_000);
        s.driver.start();
        s.driver.settled().await;
        assert_eq!(s.host.started().len(), 1);
        assert!(s.host.started()[0].1.starts_with("[SCHEDULE REMINDER]\n"));
        assert!(
            s.driver.is_waiting("session-1"),
            "the batch waits behind the turn the one-shot started"
        );
        s.host.idle("session-1", &s.driver);
        s.timers.flush_deferred();
        s.driver.settled().await;
        assert_eq!(s.host.started().len(), 2);
        assert!(
            s.host.started()[1]
                .1
                .starts_with("[SCHEDULE REMINDER BATCH]\n")
        );
        assert_eq!(
            s.service.tasks()[1].record.scheduled_at,
            "2026-10-30T12:00:30.000Z"
        );
    }

    #[tokio::test]
    async fn the_timer_delay_is_clamped_to_what_a_node_timer_can_hold() {
        let s = setup("dlv-clamp", &[], true);
        s.create(
            "session-1",
            json!({"prompt": "p", "title": "t", "at": "2030-01-01T00:00:00Z"}),
        )
        .await;
        s.driver.settled().await;
        assert_eq!(s.timers.armed(), Some(MAX_TIMER_DELAY_MS as u64));
    }

    #[tokio::test]
    async fn nothing_is_delivered_before_start_and_nothing_after_dispose() {
        let s = setup("dlv-start", &[], false);
        s.create(
            "session-1",
            json!({"prompt": "p", "title": "t", "after_seconds": 60}),
        )
        .await;
        s.at(120_000);
        s.create(
            "session-1",
            json!({"prompt": "p", "title": "t", "after_seconds": 60}),
        )
        .await;
        s.driver.settled().await;
        assert!(
            s.host.started().is_empty(),
            "writes before start do not drive"
        );
        s.driver.dispose().await;
        s.driver.start();
        s.driver.request_drive();
        s.driver.settled().await;
        assert!(s.host.started().is_empty());
    }
}
