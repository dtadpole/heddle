//! The completion notice: how a session learns that a job it started has finished without polling for it
//! (`src/jobs/notice.ts`, from `dsh-tool-jobs/lib/index.js:163-179, 262-296`, cited `TOOL:n`).
//!
//! The notice is a user message with source `{kind: 'tool-jobs', form: 'notice', summary}`. With `wakeup` delivery an
//! idle owner is woken by a new turn whose prompt is the notice; a running owner gets it injected into its next step,
//! which in heddle is the session inbox's next-step list (`queue_steer`, DSH's `inject`). Deliveries to one session
//! run one at a time.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;
use serde::Serialize;
use tokio::sync::{Notify, mpsc};

use crate::js::{is_safe_integer, json_number};
use crate::registry::{JobEvent, JobRegistry, JobView, SettleCause, Subscription};
use crate::tools::{public_job, status_line};

/// The notice's source: who wrote the message, and the one-line summary a collapsed row shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoticeSource {
    pub kind: &'static str,
    pub form: &'static str,
    pub summary: String,
}

impl NoticeSource {
    /// As the JSON a message's `source` carries.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("a source serializes")
    }
}

/// DSH's summary bound (`dsh-llm` `boundContextSummary`: 120 characters, the last one an ellipsis), counted in
/// UTF-16 code units as JavaScript counts them.
fn bound_summary(summary: &str) -> String {
    let units: Vec<u16> = summary.encode_utf16().collect();
    if units.len() <= 120 {
        return summary.to_owned();
    }
    format!("{}…", String::from_utf16_lossy(&units[..119]))
}

fn line_of(job: &JobView) -> String {
    let public = public_job(job);
    status_line(public.status.as_str(), public.detail.as_deref())
}

/// `background job <id> (<kind>: <label>) finished [status: <s>[, <detail>]]. Read its output with job_output.`
pub fn notice_text(job: &JobView) -> String {
    format!(
        "background job {} ({}: {}) finished {}. Read its output with job_output.",
        job.id,
        job.kind,
        job.label,
        line_of(job)
    )
}

/// `<kind> <label> [status: …]`, bounded (TOOL:160-162).
pub fn notice_source(job: &JobView) -> NoticeSource {
    NoticeSource {
        kind: "tool-jobs",
        form: "notice",
        summary: bound_summary(&format!("{} {} {}", job.kind, job.label, line_of(job))),
    }
}

/// What delivery needs from its host — the session store, the live-turn registry and the turn starter.
pub trait NoticeHost: Send + Sync {
    /// Whether the session still exists; a notice for a session that is gone is dropped.
    fn exists(&self, session: &str) -> bool;
    /// Whether a turn is in flight in the session.
    fn is_running(&self, session: &str) -> bool;
    /// Resolves once the session has no turn in flight.
    fn when_idle(&self, session: &str) -> BoxFuture<'static, ()>;
    /// Put the notice into the session's next-step input and answer the pending message's id.
    fn inject(&self, session: &str, text: &str, source: &NoticeSource) -> Result<String, String>;
    /// Whether that pending message is still waiting to be claimed by a step.
    fn is_pending(&self, session: &str, message_id: &str) -> bool;
    /// Start a turn in the session, without waiting for it to finish. With `answer_pending` the notice is already in
    /// the session's input and the turn claims it rather than writing it again.
    fn wake(&self, session: &str, text: &str, source: &NoticeSource, answer_pending: bool);
    /// Report a contained failure.
    fn warn(&self, message: &str);
}

/// How notices are delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompletionDelivery {
    /// DSH's default: start a turn for an idle owner.
    #[default]
    Wakeup,
    /// Only ever inject.
    Quiet,
}

/// What delivery is built with.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoticeOptions {
    pub completion_delivery: CompletionDelivery,
    /// Wakes per session before a person's message; unset is unbounded (DSH's default). Past the budget a notice is
    /// injected without a wake, and no cap text is added.
    pub max_consecutive_wakes: Option<f64>,
}

type Task = Box<dyn FnOnce() -> BoxFuture<'static, Result<(), String>> + Send>;

struct Inner {
    host: Arc<dyn NoticeHost>,
    delivery: CompletionDelivery,
    wake_budget: Option<u64>,
    spent_wakes: Mutex<HashMap<String, u64>>,
    killed_by_model: Mutex<HashSet<String>>,
    lanes: Mutex<HashMap<String, mpsc::UnboundedSender<Task>>>,
    in_flight: AtomicUsize,
    drained: Notify,
    disposed: AtomicBool,
    runtime: Option<tokio::runtime::Handle>,
}

/// Delivers completion notices for one registry.
pub struct NoticeDelivery {
    inner: Arc<Inner>,
    subscription: Subscription,
}

impl NoticeDelivery {
    /// Deliver notices for `jobs` through `host`. `Err` when the wake budget is not a whole number of turns.
    pub fn new(
        jobs: &JobRegistry,
        host: Arc<dyn NoticeHost>,
        options: NoticeOptions,
        runtime: Option<tokio::runtime::Handle>,
    ) -> Result<Self, String> {
        let wake_budget = match options.max_consecutive_wakes {
            None => None,
            Some(budget) if is_safe_integer(budget) && budget >= 1.0 => Some(budget as u64),
            Some(budget) => {
                return Err(format!(
                    "jobs: maxConsecutiveWakes ({}) must be a whole number of turns",
                    json_number(budget)
                ));
            }
        };
        let inner = Arc::new(Inner {
            host,
            delivery: options.completion_delivery,
            wake_budget,
            spent_wakes: Mutex::new(HashMap::new()),
            killed_by_model: Mutex::new(HashSet::new()),
            lanes: Mutex::new(HashMap::new()),
            in_flight: AtomicUsize::new(0),
            drained: Notify::new(),
            disposed: AtomicBool::new(false),
            runtime: runtime.or_else(|| tokio::runtime::Handle::try_current().ok()),
        });
        let weak = Arc::downgrade(&inner);
        let subscription = jobs.subscribe(move |event| {
            if let Some(inner) = weak.upgrade() {
                on_event(&inner, event);
            }
        });
        Ok(Self {
            inner,
            subscription,
        })
    }

    /// The model asked this job to stop with `job_kill`; its settle sends no notice.
    pub fn mark_model_kill(&self, id: &str) {
        lock(&self.inner.killed_by_model).insert(id.to_owned());
    }

    /// A callback form of [`mark_model_kill`](Self::mark_model_kill) for the tools, holding delivery weakly.
    pub fn model_kill_marker(&self) -> crate::tools::ModelKill {
        let weak = Arc::downgrade(&self.inner);
        Arc::new(move |id: &str| {
            if let Some(inner) = weak.upgrade() {
                lock(&inner.killed_by_model).insert(id.to_owned());
            }
        })
    }

    /// A person wrote in the session: the wake count starts again (DSH resets it on a claimed user message).
    pub fn reset_wakes(&self, session: &str) {
        lock(&self.inner.spent_wakes).remove(session);
    }

    /// Deliveries in flight or queued, settled; for tests and teardown.
    pub async fn idle(&self) {
        loop {
            let notified = self.inner.drained.notified();
            if self.inner.in_flight.load(Ordering::SeqCst) == 0 {
                return;
            }
            notified.await;
        }
    }

    /// Stop delivering.
    pub fn dispose(&self) {
        self.inner.disposed.store(true, Ordering::SeqCst);
        self.subscription.unsubscribe();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// No notice when the model killed the job itself, when a waiter collected the settle, on teardown, for an unowned
/// job, or when the owner is gone (TOOL:263-271). A person's kill still notifies.
fn on_event(inner: &Arc<Inner>, event: &JobEvent) {
    match event {
        JobEvent::Removed { job } => {
            lock(&inner.killed_by_model).remove(&job.id);
        }
        JobEvent::Settled {
            job,
            cause,
            awaited,
        } => {
            let killed_by_model = lock(&inner.killed_by_model).remove(&job.id);
            if killed_by_model || *awaited || *cause == SettleCause::Teardown {
                return;
            }
            let Some(owner) = job.owner.clone() else {
                return;
            };
            let job = job.clone();
            let weak = Arc::downgrade(inner);
            let session = owner.clone();
            enqueue(
                inner,
                &owner,
                Box::new(move || {
                    Box::pin(async move {
                        if let Some(inner) = weak.upgrade() {
                            deliver_now(&inner, &session, &job)?;
                        }
                        Ok(())
                    })
                }),
            );
        }
        _ => {}
    }
}

/// Run `task` after every task queued before it for the session.
fn enqueue(inner: &Arc<Inner>, session: &str, task: Task) {
    let Some(runtime) = inner.runtime.clone() else {
        inner
            .host
            .warn("jobs: no async runtime is running to deliver a completion notice");
        return;
    };
    inner.in_flight.fetch_add(1, Ordering::SeqCst);
    let mut lanes = lock(&inner.lanes);
    let task = match lanes.get(session) {
        Some(lane) => match lane.send(task) {
            Ok(()) => return,
            Err(mpsc::error::SendError(task)) => task,
        },
        None => task,
    };
    let (sender, mut receiver) = mpsc::unbounded_channel::<Task>();
    let _ = sender.send(task);
    lanes.insert(session.to_owned(), sender);
    drop(lanes);
    let weak: Weak<Inner> = Arc::downgrade(inner);
    let session = session.to_owned();
    runtime.spawn(async move {
        while let Some(task) = receiver.recv().await {
            let result = task().await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            if let Err(error) = result {
                inner.host.warn(&format!(
                    "jobs: a completion notice for session {session} failed: {error}"
                ));
            }
            if inner.in_flight.fetch_sub(1, Ordering::SeqCst) == 1 {
                inner.drained.notify_waiters();
            }
        }
    });
}

/// Spend one wake if the budget allows it.
fn spend_wake(inner: &Inner, session: &str) -> bool {
    let Some(budget) = inner.wake_budget else {
        return true;
    };
    let mut spent = lock(&inner.spent_wakes);
    let count = spent.entry(session.to_owned()).or_insert(0);
    if *count >= budget {
        return false;
    }
    *count += 1;
    true
}

fn deliver_now(inner: &Arc<Inner>, owner: &str, job: &JobView) -> Result<(), String> {
    if inner.disposed.load(Ordering::SeqCst) || !inner.host.exists(owner) {
        return Ok(());
    }
    let text = notice_text(job);
    let source = notice_source(job);
    let wakeup = inner.delivery == CompletionDelivery::Wakeup;
    if wakeup && !inner.host.is_running(owner) && spend_wake(inner, owner) {
        inner.host.wake(owner, &text, &source, false);
        return Ok(());
    }
    let pending = inner.host.inject(owner, &text, &source)?;
    // A running turn takes injected input at its next step, and asks once more before it ends; a notice written in
    // the gap after that last look would wait for the next person. So, as heddle's background-subagent notice does,
    // the deliverer waits for the session to go idle and answers a notice still pending with a turn of its own. The
    // wait runs outside the session's queue, so later notices still reach the running turn.
    if wakeup && inner.host.is_running(owner) {
        let idle = inner.host.when_idle(owner);
        let weak = Arc::downgrade(inner);
        let session = owner.to_owned();
        if let Some(runtime) = inner.runtime.clone() {
            runtime.spawn(async move {
                idle.await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let lane_inner = Arc::downgrade(&inner);
                let lane_session = session.clone();
                enqueue(
                    &inner,
                    &session,
                    Box::new(move || {
                        Box::pin(async move {
                            let Some(inner) = lane_inner.upgrade() else {
                                return Ok(());
                            };
                            if inner.disposed.load(Ordering::SeqCst)
                                || !inner.host.exists(&lane_session)
                            {
                                return Ok(());
                            }
                            if inner.host.is_running(&lane_session)
                                || !inner.host.is_pending(&lane_session, &pending)
                            {
                                return Ok(());
                            }
                            if spend_wake(&inner, &lane_session) {
                                inner.host.wake(&lane_session, &text, &source, true);
                            }
                            Ok(())
                        })
                    }),
                );
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::tests::{Manual, manual_spec};
    use crate::registry::{JobOutcome, JobOutput, JobRegistryOptions, JobStatus, OutcomeStatus};
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[derive(Debug, Clone, PartialEq)]
    struct Call {
        op: &'static str,
        session: String,
        text: String,
        source: NoticeSource,
        answer_pending: Option<bool>,
    }

    #[derive(Default)]
    struct FakeHost {
        running: Mutex<HashSet<String>>,
        sessions: Mutex<HashSet<String>>,
        pending: Mutex<HashSet<String>>,
        idle: Mutex<HashMap<String, Vec<oneshot::Sender<()>>>>,
        calls: Mutex<Vec<Call>>,
        next: AtomicUsize,
    }

    impl FakeHost {
        fn new() -> Arc<Self> {
            let host = Self::default();
            lock(&host.sessions).extend(["session-a".to_owned(), "session-b".to_owned()]);
            Arc::new(host)
        }

        fn calls(&self) -> Vec<Call> {
            lock(&self.calls).clone()
        }

        fn ops(&self) -> Vec<&'static str> {
            self.calls().iter().map(|call| call.op).collect()
        }

        fn finish_turn(&self, session: &str) {
            lock(&self.running).remove(session);
            for waiter in lock(&self.idle).remove(session).unwrap_or_default() {
                let _ = waiter.send(());
            }
        }
    }

    impl NoticeHost for FakeHost {
        fn exists(&self, session: &str) -> bool {
            lock(&self.sessions).contains(session)
        }
        fn is_running(&self, session: &str) -> bool {
            lock(&self.running).contains(session)
        }
        fn when_idle(&self, session: &str) -> BoxFuture<'static, ()> {
            if !self.is_running(session) {
                return Box::pin(async {});
            }
            let (sender, receiver) = oneshot::channel();
            lock(&self.idle)
                .entry(session.to_owned())
                .or_default()
                .push(sender);
            Box::pin(async move {
                let _ = receiver.await;
            })
        }
        fn inject(
            &self,
            session: &str,
            text: &str,
            source: &NoticeSource,
        ) -> Result<String, String> {
            lock(&self.calls).push(Call {
                op: "inject",
                session: session.into(),
                text: text.into(),
                source: source.clone(),
                answer_pending: None,
            });
            let id = format!("inbox-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
            lock(&self.pending).insert(id.clone());
            Ok(id)
        }
        fn is_pending(&self, _session: &str, message_id: &str) -> bool {
            lock(&self.pending).contains(message_id)
        }
        fn wake(&self, session: &str, text: &str, source: &NoticeSource, answer_pending: bool) {
            lock(&self.calls).push(Call {
                op: "wake",
                session: session.into(),
                text: text.into(),
                source: source.clone(),
                answer_pending: Some(answer_pending),
            });
        }
        fn warn(&self, _message: &str) {}
    }

    fn setup(options: NoticeOptions) -> (JobRegistry, NoticeDelivery, Arc<FakeHost>) {
        let jobs = JobRegistry::new(JobRegistryOptions {
            session_exists: Some(Arc::new(|id: &str| id.starts_with("session-"))),
            ..JobRegistryOptions::default()
        });
        let _ = jobs.attach_controller("test");
        let host = FakeHost::new();
        let delivery = NoticeDelivery::new(&jobs, host.clone(), options, None).unwrap();
        (jobs, delivery, host)
    }

    fn manual(owner: Option<&str>, label: &str) -> (crate::registry::JobSpec, Manual) {
        manual_spec(owner, label, None)
    }

    async fn settle_job(delivery: &NoticeDelivery, producer: &Manual, outcome: JobOutcome) {
        producer.finish(outcome);
        tokio::time::sleep(Duration::from_millis(60)).await;
        delivery.idle().await;
    }

    fn done(status: OutcomeStatus, detail: Option<&str>) -> JobOutcome {
        JobOutcome::new(status, detail)
    }

    #[test]
    fn the_notice_text_and_source_are_dshs() {
        let mut job = JobView {
            id: "bash-0123456789abcdef".into(),
            kind: "bash".into(),
            label: "npm test".into(),
            owner: Some("session-a".into()),
            output_limit_bytes: None,
            status: JobStatus::Completed,
            progress: None,
            detail: Some("exit code: 1".into()),
            started_at: 1,
            finished_at: Some(2),
            output: JobOutput {
                total: 0,
                earliest: 0,
                spill_paths: None,
            },
        };
        assert_eq!(
            notice_text(&job),
            "background job bash-0123456789abcdef (bash: npm test) finished [status: completed, exit code: 1]. Read its output with job_output."
        );
        assert_eq!(
            notice_source(&job).to_value(),
            serde_json::json!({ "kind": "tool-jobs", "form": "notice", "summary": "bash npm test [status: completed, exit code: 1]" })
        );
        let bare = JobView {
            detail: None,
            ..job.clone()
        };
        assert_eq!(
            notice_text(&bare),
            "background job bash-0123456789abcdef (bash: npm test) finished [status: completed]. Read its output with job_output."
        );
        job.label = "x".repeat(200);
        let long = notice_source(&job).summary;
        assert_eq!(long.encode_utf16().count(), 120);
        assert!(long.ends_with('…'));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_idle_owner_is_woken_and_a_running_owner_gets_it_injected() {
        let (jobs, delivery, host) = setup(NoticeOptions::default());
        let (spec, idle) = manual(Some("session-a"), "make build");
        let id = jobs.start(spec).unwrap();
        settle_job(
            &delivery,
            &idle,
            done(OutcomeStatus::Completed, Some("exit code: 0")),
        )
        .await;
        let calls = host.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].op, "wake");
        assert_eq!(calls[0].answer_pending, Some(false));
        assert_eq!(
            calls[0].text,
            format!(
                "background job {id} (bash: make build) finished [status: completed, exit code: 0]. Read its output with job_output."
            )
        );
        lock(&host.running).insert("session-b".into());
        let (spec, busy) = manual(Some("session-b"), "make build");
        jobs.start(spec).unwrap();
        settle_job(
            &delivery,
            &busy,
            done(OutcomeStatus::Completed, Some("exit code: 0")),
        )
        .await;
        let calls = host.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].op, "inject");
        assert_eq!(calls[1].source.kind, "tool-jobs");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_notice_injected_into_a_turn_that_ended_without_claiming_it_is_answered_by_a_turn() {
        let (jobs, delivery, host) = setup(NoticeOptions::default());
        lock(&host.running).insert("session-a".into());
        let (spec, producer) = manual(Some("session-a"), "make build");
        jobs.start(spec).unwrap();
        settle_job(
            &delivery,
            &producer,
            done(OutcomeStatus::Completed, Some("exit code: 0")),
        )
        .await;
        assert_eq!(host.ops(), ["inject"]);
        host.finish_turn("session-a");
        tokio::time::sleep(Duration::from_millis(30)).await;
        delivery.idle().await;
        assert_eq!(
            host.calls()
                .iter()
                .map(|call| (call.op, call.answer_pending))
                .collect::<Vec<_>>(),
            [("inject", None), ("wake", Some(true))]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_notice_when_awaited_model_killed_torn_down_unowned_or_gone_and_a_persons_kill_notifies()
     {
        let (jobs, delivery, host) = setup(NoticeOptions::default());
        let (spec, awaited) = manual(Some("session-a"), "make build");
        let awaited_id = jobs.start(spec).unwrap();
        let waiting = {
            let jobs = jobs.clone();
            tokio::spawn(async move {
                jobs.wait(&awaited_id, 10_000.0, Some("session-a"), None)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        settle_job(&delivery, &awaited, done(OutcomeStatus::Completed, None)).await;
        waiting.await.unwrap().unwrap();

        let (spec, model_killed) = manual(Some("session-a"), "make build");
        let model_id = jobs.start(spec).unwrap();
        jobs.kill(&model_id, Some("session-a"), None).unwrap();
        delivery.mark_model_kill(&model_id);
        settle_job(
            &delivery,
            &model_killed,
            done(OutcomeStatus::Killed, Some("signal: SIGTERM")),
        )
        .await;

        let (spec, unowned) = manual(None, "make build");
        jobs.start(spec).unwrap();
        settle_job(&delivery, &unowned, done(OutcomeStatus::Completed, None)).await;

        let (spec, orphan) = manual(Some("session-b"), "make build");
        jobs.start(spec).unwrap();
        lock(&host.sessions).remove("session-b");
        settle_job(&delivery, &orphan, done(OutcomeStatus::Completed, None)).await;
        assert!(host.calls().is_empty());

        let (spec, person) = manual(Some("session-a"), "sleep 30");
        let person_id = jobs.start(spec).unwrap();
        jobs.kill(&person_id, Some("session-a"), Some("cancelled by the user"))
            .unwrap();
        settle_job(
            &delivery,
            &person,
            done(OutcomeStatus::Killed, Some("signal: SIGTERM")),
        )
        .await;
        let calls = host.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].text,
            format!(
                "background job {person_id} (bash: sleep 30) finished [status: killed, signal: SIGTERM; cancelled by the user]. Read its output with job_output."
            )
        );

        let (spec, torn) = manual(Some("session-a"), "make build");
        jobs.start(spec).unwrap();
        let disposing = {
            let jobs = jobs.clone();
            tokio::spawn(async move { jobs.dispose().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        settle_job(&delivery, &torn, done(OutcomeStatus::Killed, None)).await;
        disposing.await.unwrap();
        assert_eq!(host.calls().len(), 1, "teardown sends nothing");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quiet_delivery_only_injects_even_for_an_idle_owner() {
        let (jobs, delivery, host) = setup(NoticeOptions {
            completion_delivery: CompletionDelivery::Quiet,
            max_consecutive_wakes: None,
        });
        let (spec, producer) = manual(Some("session-a"), "make build");
        jobs.start(spec).unwrap();
        settle_job(&delivery, &producer, done(OutcomeStatus::Completed, None)).await;
        assert_eq!(host.ops(), ["inject"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn past_the_wake_budget_a_notice_is_injected_and_a_persons_message_resets_the_count() {
        let (jobs, delivery, host) = setup(NoticeOptions {
            completion_delivery: CompletionDelivery::Wakeup,
            max_consecutive_wakes: Some(2.0),
        });
        for _ in 0..3 {
            let (spec, producer) = manual(Some("session-a"), "make build");
            jobs.start(spec).unwrap();
            settle_job(&delivery, &producer, done(OutcomeStatus::Completed, None)).await;
        }
        assert_eq!(host.ops(), ["wake", "wake", "inject"]);
        assert!(
            !host.calls()[2].text.contains("cap"),
            "no cap text is added"
        );
        delivery.reset_wakes("session-a");
        let (spec, producer) = manual(Some("session-a"), "make build");
        jobs.start(spec).unwrap();
        settle_job(&delivery, &producer, done(OutcomeStatus::Completed, None)).await;
        assert_eq!(host.calls()[3].op, "wake");
        let refused = NoticeDelivery::new(
            &jobs,
            FakeHost::new(),
            NoticeOptions {
                completion_delivery: CompletionDelivery::Wakeup,
                max_consecutive_wakes: Some(1.5),
            },
            None,
        );
        assert_eq!(
            refused.err().unwrap(),
            "jobs: maxConsecutiveWakes (1.5) must be a whole number of turns"
        );
    }
}
