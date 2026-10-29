//! The question service, ported from `src/questions/service.ts`.
//!
//! A request is `question/asked`, then at most one of `question/answered` or `question/cancelled`, with
//! `question/pending` in between when a timed wait ran out first - all in the session's own log, so the state of every
//! request is the fold of those events and survives a restart. Which requests have a turn waiting on them, and which a
//! person is holding with Take time, only the process knows; that is kept beside the log.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use heddle_session::clock::{iso_from, iso_now};
use serde_json::{json, Map, Value};
use tokio::sync::{oneshot, Notify};
use tokio_util::sync::CancellationToken;

use crate::log::QuestionLog;
use crate::model::{
    codes, validate_answers, validate_questions, Answer, Question, QuestionError, DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS, QUESTION_EVENT_VERSION,
};

/// How a call waits: `Legacy` until an answer, `Timed` until a deadline (DSH's two tool definitions).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Mode {
    /// Wait for the answer, as DSH's shipped presets do.
    #[default]
    Legacy,
    /// Release the model at the deadline while the question stays answerable.
    Timed,
}

/// The plugin row's config: `{ mode, timeout }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuestionConfig {
    /// Legacy or timed.
    pub mode: Mode,
    /// The default wait of a timed call in seconds; `-1` waits indefinitely.
    pub timeout: i64,
}

impl Default for QuestionConfig {
    fn default() -> Self {
        Self { mode: Mode::Legacy, timeout: DEFAULT_TIMEOUT_SECONDS }
    }
}

impl QuestionConfig {
    /// Read the row's `config` object: `mode` is `legacy` or `timed`, `timeout` a positive integer or `-1`.
    pub fn from_value(config: Option<&Value>) -> Self {
        let mode = match config.and_then(|config| config.get("mode")).and_then(Value::as_str) {
            Some("timed") => Mode::Timed,
            _ => Mode::Legacy,
        };
        let timeout = config.and_then(|config| config.get("timeout")).and_then(Value::as_i64).unwrap_or(DEFAULT_TIMEOUT_SECONDS);
        Self { mode, timeout }
    }
}

/// What `ask` resolves to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AskOutcome {
    /// The person answered while the turn waited.
    Answered(Vec<Answer>),
    /// A timed wait ran out; the request stays answerable under this id.
    Pending {
        /// The request id the model is told.
        call_id: String,
    },
}

/// What `answer` reports.
#[derive(Clone, Debug, PartialEq)]
pub struct AnswerOutcome {
    /// The request's view after the answer.
    pub view: Map<String, Value>,
    /// No turn was waiting: the caller must deliver `message` as a user message.
    pub late: bool,
    /// DSH's `answer_to_pending_question` text, for a late answer.
    pub message: Option<String>,
}

/// How a request was settled, as the log says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settled {
    /// Answered, possibly late.
    Answered {
        /// The answers.
        answers: Vec<Answer>,
        /// When, from the event's `at`.
        at: String,
        /// Whether no turn was waiting.
        late: bool,
    },
    /// Cancelled, with its reason.
    Cancelled {
        /// Why (`stopped`).
        reason: String,
        /// When.
        at: String,
    },
}

/// A request as the log describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoldedRequest {
    /// `question-<uuid>`.
    pub id: String,
    /// The batch.
    pub questions: Vec<Question>,
    /// Whether the call was timed.
    pub timed: bool,
    /// When it was asked.
    pub asked_at: String,
    /// The deadline the call was given, if timed.
    pub deadline: Option<String>,
    /// A timed wait ran out.
    pub expired: bool,
    /// The final event, if any.
    pub settled: Option<Settled>,
}

/// Fold a session's question events in log order; other events and unknown requests are ignored.
pub fn fold_questions(events: &[Value]) -> Vec<FoldedRequest> {
    let mut requests: Vec<FoldedRequest> = Vec::new();
    for event in events {
        let Some(kind) = event.get("type").and_then(Value::as_str).filter(|kind| kind.starts_with("question/")) else {
            continue;
        };
        let Some(id) = event.get("requestId").and_then(Value::as_str) else {
            continue;
        };
        let at = event.get("at").and_then(Value::as_str).unwrap_or_default().to_owned();
        if kind == "question/asked" {
            if requests.iter().any(|request| request.id == id) {
                continue;
            }
            let Some(questions) = event.get("questions").and_then(|value| serde_json::from_value::<Vec<Question>>(value.clone()).ok()) else {
                continue;
            };
            requests.push(FoldedRequest {
                id: id.to_owned(),
                questions,
                timed: event.get("timed") == Some(&Value::Bool(true)),
                asked_at: event.get("askedAt").and_then(Value::as_str).map_or(at, str::to_owned),
                deadline: event.get("deadline").and_then(Value::as_str).map(str::to_owned),
                expired: false,
                settled: None,
            });
            continue;
        }
        let Some(current) = requests.iter_mut().find(|request| request.id == id) else {
            continue;
        };
        if current.settled.is_some() {
            continue;
        }
        match kind {
            "question/pending" => current.expired = true,
            "question/answered" => {
                if let Some(answers) = event.get("answers").and_then(|value| serde_json::from_value::<Vec<Answer>>(value.clone()).ok()) {
                    current.settled = Some(Settled::Answered { answers, at, late: event.get("late") == Some(&Value::Bool(true)) });
                }
            }
            "question/cancelled" => {
                let reason = event.get("reason").and_then(Value::as_str).unwrap_or("cancelled").to_owned();
                current.settled = Some(Settled::Cancelled { reason, at });
            }
            _ => {}
        }
    }
    requests
}

/// The user-message text a late answer becomes: DSH's `answer_to_pending_question` record as compact JSON.
pub fn late_answer_message(request: &FoldedRequest, answers: &[Answer]) -> String {
    json!({
        "kind": "answer_to_pending_question",
        "tool": "ask_user_question",
        "callId": request.id,
        "questions": request.questions,
        "answers": answers,
    })
    .to_string()
}

struct Waiter {
    session: String,
    answer: Option<oneshot::Sender<Vec<Answer>>>,
    hold: Arc<Notify>,
    held: bool,
    deadline: Option<String>,
}

/// The question service: requests in the log, waiting turns and holds in the process.
pub struct QuestionService {
    log: Arc<dyn QuestionLog>,
    mode: Mode,
    default_timeout: i64,
    waiters: Mutex<HashMap<String, Waiter>>,
}

impl std::fmt::Debug for QuestionService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("QuestionService").field("mode", &self.mode).field("default_timeout", &self.default_timeout).finish_non_exhaustive()
    }
}

fn log_error(error: impl std::fmt::Display) -> QuestionError {
    QuestionError::new(codes::LOG, error.to_string())
}

impl QuestionService {
    /// A service over `log` with the row's config.
    pub fn new(log: Arc<dyn QuestionLog>, config: QuestionConfig) -> Self {
        let timeout = config.timeout;
        let default_timeout = if timeout == -1 || timeout > 0 { timeout } else { DEFAULT_TIMEOUT_SECONDS };
        Self { log, mode: config.mode, default_timeout, waiters: Mutex::new(HashMap::new()) }
    }

    /// The session's id when it exists in the log.
    pub fn open(&self, id: &str) -> Option<String> {
        self.log.open(id)
    }

    /// Legacy or timed.
    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// The default wait of a timed call.
    pub fn default_timeout(&self) -> i64 {
        self.default_timeout
    }

    /// The wait in seconds, or `None` for an untimed call.
    fn wait_seconds(&self, raw: Option<&Value>) -> Option<u64> {
        if self.mode != Mode::Timed {
            return None;
        }
        let asked = raw
            .and_then(|value| if value.is_i64() || value.is_u64() { value.as_i64() } else { None })
            .filter(|seconds| *seconds == -1 || (*seconds > 0 && *seconds <= MAX_TIMEOUT_SECONDS));
        let seconds = asked.unwrap_or(self.default_timeout);
        u64::try_from(seconds).ok()
    }

    fn append(&self, session: &str, kind: &str, fields: Value) -> Result<(), QuestionError> {
        let mut event = Map::new();
        event.insert("type".into(), Value::String(kind.into()));
        event.insert("version".into(), json!(QUESTION_EVENT_VERSION));
        if let Value::Object(fields) = fields {
            event.extend(fields);
        }
        self.log.append(session, event).map(|_| ()).map_err(log_error)
    }

    fn fold(&self, session: &str) -> Result<Vec<FoldedRequest>, QuestionError> {
        self.log.read(session).map(|events| fold_questions(&events)).map_err(log_error)
    }

    /// Ask a batch and wait: a legacy call (or a timed `-1`) until an answer or a Stop, a timed call until its
    /// deadline unless a person holds it. A Stop records the cancellation and answers `CANCELLED`.
    pub async fn ask(&self, session: &str, raw: &Value, timeout: Option<&Value>, cancel: Option<CancellationToken>) -> Result<AskOutcome, QuestionError> {
        let questions = validate_questions(raw)?;
        let seconds = self.wait_seconds(timeout);
        if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(QuestionError::new(codes::CANCELLED, "the turn was stopped before the question was asked"));
        }
        let id = format!("question-{}", uuid::Uuid::new_v4());
        let deadline = seconds.map(|seconds| iso_from(Utc::now() + chrono::Duration::seconds(i64::try_from(seconds).unwrap_or(i64::MAX))));
        self.append(
            session,
            "question/asked",
            json!({ "requestId": id, "questions": questions, "timed": seconds.is_some(), "askedAt": iso_now(), "deadline": deadline }),
        )?;
        let (sender, mut receiver) = oneshot::channel();
        let hold = Arc::new(Notify::new());
        self.waiters.lock().expect("waiters").insert(
            id.clone(),
            Waiter { session: session.to_owned(), answer: Some(sender), hold: Arc::clone(&hold), held: false, deadline: deadline.clone() },
        );
        let mut until = seconds.map(|seconds| tokio::time::Instant::now() + Duration::from_secs(seconds));
        let stopped = async {
            match cancel {
                Some(token) => token.cancelled_owned().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(stopped);
        loop {
            let sleep = async {
                match until {
                    Some(instant) => tokio::time::sleep_until(instant).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                biased;
                answered = &mut receiver => {
                    return match answered {
                        Ok(answers) => Ok(AskOutcome::Answered(answers)),
                        Err(_) => Err(QuestionError::new(codes::CANCELLED, "the question was withdrawn")),
                    };
                }
                () = &mut stopped => {
                    if self.release(&id).is_some() {
                        self.append(session, "question/cancelled", json!({ "requestId": id, "reason": "stopped" }))?;
                    }
                    return Err(QuestionError::new(codes::CANCELLED, "the turn was stopped while the question waited"));
                }
                () = hold.notified() => {
                    until = None;
                }
                () = sleep => {
                    let still_waiting = self.waiters.lock().expect("waiters").get(&id).is_some_and(|waiter| !waiter.held);
                    if !still_waiting {
                        until = None;
                        continue;
                    }
                    self.release(&id);
                    self.append(session, "question/pending", json!({ "requestId": id }))?;
                    return Ok(AskOutcome::Pending { call_id: id });
                }
            }
        }
    }

    /// Every request in a session, oldest first; `open` keeps those still answerable.
    pub fn list(&self, session: &str, open: bool) -> Result<Vec<Map<String, Value>>, QuestionError> {
        let views: Vec<Map<String, Value>> = self.fold(session)?.iter().map(|request| self.view(session, request)).collect();
        if !open {
            return Ok(views);
        }
        Ok(views
            .into_iter()
            .filter(|view| matches!(view.get("state").and_then(Value::as_str), Some("waiting" | "pending" | "continued")))
            .collect())
    }

    /// One request, or `None`.
    pub fn get(&self, session: &str, id: &str) -> Result<Option<Map<String, Value>>, QuestionError> {
        Ok(self.fold(session)?.iter().find(|request| request.id == id).map(|request| self.view(session, request)))
    }

    /// Answer a request: a waiting turn receives the answers as its tool result; with none waiting the answer is
    /// recorded late and `message` is the user message the caller delivers.
    pub fn answer(&self, session: &str, id: &str, raw: &Value) -> Result<AnswerOutcome, QuestionError> {
        let requests = self.fold(session)?;
        let Some(request) = requests.iter().find(|request| request.id == id) else {
            return Err(QuestionError::new(codes::NOT_FOUND, format!("no question request '{id}' in this session")));
        };
        if let Some(settled) = &request.settled {
            let kind = match settled {
                Settled::Answered { .. } => "answered",
                Settled::Cancelled { .. } => "cancelled",
            };
            return Err(QuestionError::new(codes::SETTLED, format!("question request '{id}' is already {kind}")));
        }
        let answers = validate_answers(&request.questions, raw)?;
        let waiting = self.waiters.lock().expect("waiters").contains_key(id);
        let late = !waiting;
        self.append(session, "question/answered", json!({ "requestId": id, "answers": answers, "late": late }))?;
        if let Some(mut waiter) = self.release(id)
            && let Some(sender) = waiter.answer.take()
        {
            let _ = sender.send(answers.clone());
        }
        let view = self.get(session, id)?.unwrap_or_default();
        let message = late.then(|| late_answer_message(request, &answers));
        Ok(AnswerOutcome { view, late, message })
    }

    /// Take time: keep a timed wait from running out. Only a request a turn waits on can be held; for any other
    /// the call changes nothing and returns the current view.
    pub fn hold(&self, session: &str, id: &str) -> Result<Map<String, Value>, QuestionError> {
        let requests = self.fold(session)?;
        let Some(request) = requests.iter().find(|request| request.id == id) else {
            return Err(QuestionError::new(codes::NOT_FOUND, format!("no question request '{id}' in this session")));
        };
        if let Some(waiter) = self.waiters.lock().expect("waiters").get_mut(id).filter(|waiter| waiter.session == session) {
            waiter.held = true;
            waiter.deadline = None;
            waiter.hold.notify_one();
        }
        Ok(self.view(session, request))
    }

    /// Whether a turn in this process waits on a request.
    pub fn is_waiting(&self, id: &str) -> bool {
        self.waiters.lock().expect("waiters").contains_key(id)
    }

    fn release(&self, id: &str) -> Option<Waiter> {
        self.waiters.lock().expect("waiters").remove(id)
    }

    /// The request as a reader sees it, with the TypeScript build's key order.
    fn view(&self, session: &str, request: &FoldedRequest) -> Map<String, Value> {
        let waiters = self.waiters.lock().expect("waiters");
        let waiter = waiters.get(&request.id);
        let mut view = Map::new();
        view.insert("id".into(), Value::String(request.id.clone()));
        view.insert("session".into(), Value::String(session.to_owned()));
        view.insert("questions".into(), serde_json::to_value(&request.questions).unwrap_or(Value::Null));
        view.insert("timed".into(), Value::Bool(request.timed));
        view.insert("askedAt".into(), Value::String(request.asked_at.clone()));
        view.insert("deadline".into(), waiter.and_then(|waiter| waiter.deadline.clone()).map_or(Value::Null, Value::String));
        view.insert("held".into(), Value::Bool(waiter.is_some_and(|waiter| waiter.held)));
        match &request.settled {
            Some(Settled::Answered { answers, at, late }) => {
                view.insert("deadline".into(), Value::Null);
                view.insert("state".into(), json!("answered"));
                view.insert("answers".into(), serde_json::to_value(answers).unwrap_or(Value::Null));
                view.insert("answeredAt".into(), Value::String(at.clone()));
                view.insert("late".into(), Value::Bool(*late));
            }
            Some(Settled::Cancelled { reason, .. }) => {
                view.insert("deadline".into(), Value::Null);
                view.insert("state".into(), json!("cancelled"));
                view.insert("reason".into(), Value::String(reason.clone()));
            }
            None if waiter.is_some() => {
                view.insert("state".into(), json!("waiting"));
            }
            None => {
                view.insert("deadline".into(), Value::Null);
                view.insert("state".into(), json!(if request.expired { "pending" } else { "continued" }));
            }
        }
        view
    }
}
