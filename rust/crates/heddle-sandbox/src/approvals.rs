//! The approval policy and the channel a person answers a question through.
//!
//! Ported from `src/approvals/service.ts`. Two jobs, one decision. The **standing policy** (`allow` / `deny` /
//! `ask`, tools named in `deny` and `allow`, and an `unanswered` answer for a run nobody can answer) decides
//! **whether** an action may be taken at all — a different refusal from the sandbox's **where**, and a person
//! needs to know which one stopped them. The **question** is what a tool asks before a wider action: an
//! answering surface attaches (the Web UI does on start), [`ApprovalService::request`] publishes the question
//! and waits, and [`ApprovalService::answer`] settles it. A headless run has no answerer, so it gets its
//! `unanswered` answer at once instead of hanging on a card nobody can see.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};

use crate::escalation::EscalationApproval;

/// The standing policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    /// Every tool not denied by name runs.
    #[default]
    Allow,
    /// Only tools allowed by name run.
    Deny,
    /// Every tool would be asked about; with no one to answer, `unanswered` decides.
    Ask,
}

impl ApprovalMode {
    /// `allow`, `deny` or `ask`.
    pub const fn as_str(self) -> &'static str {
        match self {
            ApprovalMode::Allow => "allow",
            ApprovalMode::Deny => "deny",
            ApprovalMode::Ask => "ask",
        }
    }
}

/// The answer given when nothing can answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unanswered {
    /// Refuse (the default).
    #[default]
    Deny,
    /// Allow.
    Allow,
}

/// The `approvals` row's `config` (camelCase keys; unknown keys ignored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApprovalsConfig {
    /// `allow` by default.
    pub mode: ApprovalMode,
    /// Tools refused by name, whatever the mode says (unless also in `allow`).
    pub deny: Vec<String>,
    /// Tools allowed by name even when the mode is `deny`.
    pub allow: Vec<String>,
    /// The answer to an `ask` when nothing can answer it; `deny` by default.
    pub unanswered: Unanswered,
    /// How long a question waits before it is withdrawn as `cancelled`; 300 000 ms by default.
    pub answer_timeout_ms: u64,
}

impl Default for ApprovalsConfig {
    fn default() -> ApprovalsConfig {
        ApprovalsConfig {
            mode: ApprovalMode::Allow,
            deny: Vec::new(),
            allow: Vec::new(),
            unanswered: Unanswered::Deny,
            answer_timeout_ms: 300_000,
        }
    }
}

/// What the standing policy says about one call (`ApprovalDecision`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDecision {
    /// Whether the call may run.
    pub allowed: bool,
    /// The policy's mode when it decided.
    pub mode: ApprovalMode,
    /// The sentence a person is shown; always present when refused. The registry reports a refusal under
    /// code `DENIED`.
    pub reason: Option<String>,
}

/// One remembered decision (`history()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionRecord {
    /// The tool, or `command:<name>` for a command.
    pub tool: String,
    /// Whether it was allowed.
    pub allowed: bool,
    /// The decision's reason, when it had one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The closed outcome vocabulary of one question (`ApprovalOutcome`): `allowed-once` is the only grant and
/// applies to the one call that asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalOutcome {
    /// A person allowed exactly this call (or `unanswered: allow` with no one to ask).
    AllowedOnce,
    /// A person said no.
    Rejected,
    /// The ask was withdrawn: cancelled by a Stop, or by the answer timeout.
    Cancelled,
    /// No one could answer on this run.
    Unavailable,
}

impl ApprovalOutcome {
    /// `allowed-once`, `rejected`, `cancelled` or `unavailable`.
    pub const fn as_str(self) -> &'static str {
        match self {
            ApprovalOutcome::AllowedOnce => "allowed-once",
            ApprovalOutcome::Rejected => "rejected",
            ApprovalOutcome::Cancelled => "cancelled",
            ApprovalOutcome::Unavailable => "unavailable",
        }
    }
}

/// What a person may answer through `POST /api/approvals/<id>` — the outcome vocabulary without
/// `unavailable`, which only the service itself can conclude.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Answer {
    /// `allowed-once`.
    AllowedOnce,
    /// `rejected`.
    Rejected,
    /// `cancelled`.
    Cancelled,
}

impl Answer {
    /// The answer a posted word names, or `None` (the route then answers 400
    /// `outcome must be 'allowed-once', 'rejected' or 'cancelled'`).
    pub fn parse(word: &str) -> Option<Answer> {
        match word {
            "allowed-once" => Some(Answer::AllowedOnce),
            "rejected" => Some(Answer::Rejected),
            "cancelled" => Some(Answer::Cancelled),
            _ => None,
        }
    }
}

impl From<Answer> for ApprovalOutcome {
    fn from(answer: Answer) -> ApprovalOutcome {
        match answer {
            Answer::AllowedOnce => ApprovalOutcome::AllowedOnce,
            Answer::Rejected => ApprovalOutcome::Rejected,
            Answer::Cancelled => ApprovalOutcome::Cancelled,
        }
    }
}

/// One question waiting for a person, as the page draws it (`ApprovalRequest`). Serialises to the TypeScript
/// JSON: `{ id, tool, reason, displayReason, session?, at }` — the body of the SSE `approval` event and of each
/// entry in `GET /api/approvals`'s `requests`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// `approval-<uuid v4>`, generated here and never accepted from a caller; see [`is_approval_id`].
    pub id: String,
    /// The tool asking.
    pub tool: String,
    /// The audit reason, in English, the way the logs are written.
    pub reason: String,
    /// What a person reads; the model's justification is carried verbatim inside it.
    pub display_reason: String,
    /// The session the call belongs to; omitted from the JSON when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// When it was asked: ISO 8601 UTC with milliseconds (`2026-10-23T01:16:42.123Z`).
    pub at: String,
}

/// What a caller asks ([`ApprovalService::request`]'s options).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ApprovalAsk {
    /// The tool asking.
    pub tool: String,
    /// The audit reason.
    pub reason: String,
    /// What a person reads; `reason` when absent.
    pub display_reason: Option<String>,
    /// The session the call belongs to.
    pub session: Option<String>,
}

/// Whether a string has the shape of an approval id — the route's check before it answers
/// (`/^approval-[0-9a-f-]{36}$/i`), so a malformed id is a 400 rather than a lookup.
pub fn is_approval_id(id: &str) -> bool {
    let _ = id;
    todo!("approval- followed by exactly 36 of [0-9a-fA-F-]")
}

/// A surface's claim that it can answer questions; dropping it (or [`AnswererGuard::detach`]) withdraws the
/// claim exactly once. Counted rather than boolean, because a server reload attaches its new answerer before the
/// old one is dropped.
#[derive(Debug)]
#[must_use = "dropping the guard detaches the answerer at once"]
pub struct AnswererGuard {
    answerers: Arc<AtomicUsize>,
}

impl AnswererGuard {
    /// Detach now (the same as dropping it).
    pub fn detach(self) {
        drop(self);
    }
}

impl Drop for AnswererGuard {
    fn drop(&mut self) {
        self.answerers.fetch_sub(1, Ordering::SeqCst);
    }
}

/// One unresolved question and the sender that settles it.
#[expect(
    dead_code,
    reason = "constructed by `request`, whose body is being ported"
)]
struct Pending {
    request: ApprovalRequest,
    settle: oneshot::Sender<ApprovalOutcome>,
}

/// The approval service (`ApprovalService`). Share it as `Arc<ApprovalService>`; every method takes `&self`.
pub struct ApprovalService {
    config: ApprovalsConfig,
    decisions: Mutex<Vec<DecisionRecord>>,
    pending: Mutex<Vec<Pending>>,
    answerers: Arc<AtomicUsize>,
    published: broadcast::Sender<ApprovalRequest>,
}

impl ApprovalService {
    /// A service over `config`, with no answerer attached and nothing pending.
    pub fn new(config: ApprovalsConfig) -> ApprovalService {
        let (published, _) = broadcast::channel(64);
        ApprovalService {
            config,
            decisions: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::new()),
            answerers: Arc::new(AtomicUsize::new(0)),
            published,
        }
    }

    /// The configuration the service was built with.
    pub fn config(&self) -> &ApprovalsConfig {
        &self.config
    }

    /// Decide one call by the standing policy, and remember the decision (`check`).
    ///
    /// In order: denied by name and not allowed by name → refused, `the approval policy denies '<tool>' by
    /// name`; mode `allow` → allowed, no reason; mode `deny` → allowed by name (`'<tool>' is allowed by name`)
    /// or refused (`the approval policy is 'deny' and '<tool>' is not allowed by name`); mode `ask` →
    /// `unanswered: allow` allows (`'<tool>' was not asked; unanswered defaults to allow`), otherwise refused
    /// (`the approval policy asks before '<tool>', and this run has no one to answer, so it is refused`).
    pub fn check(&self, tool: &str) -> ApprovalDecision {
        let _ = (tool, &self.decisions);
        todo!("port check/decide from src/approvals/service.ts")
    }

    /// Mark that a surface can answer questions (`attachAnswerer`); the guard is the disposer.
    pub fn attach_answerer(&self) -> AnswererGuard {
        self.answerers.fetch_add(1, Ordering::SeqCst);
        AnswererGuard {
            answerers: Arc::clone(&self.answerers),
        }
    }

    /// Whether anything could answer a question right now (`canAnswer`).
    pub fn can_answer(&self) -> bool {
        self.answerers.load(Ordering::SeqCst) > 0
    }

    /// The questions waiting for an answer, oldest first (`pendingRequests`) — what a reloaded page reads to
    /// repaint its card.
    pub fn pending_requests(&self) -> Vec<ApprovalRequest> {
        let _ = &self.pending;
        todo!("clone the pending requests in insertion order")
    }

    /// Every question published from now on (the TypeScript `approval/request` event). The server forwards
    /// each as an SSE `approval` event; boot may bridge it onto the event bus. A lagging receiver misses
    /// questions, so a page repaints from [`ApprovalService::pending_requests`].
    pub fn subscribe(&self) -> broadcast::Receiver<ApprovalRequest> {
        self.published.subscribe()
    }

    /// Ask a person one question and wait, or answer from policy when no one can be asked (`request`).
    ///
    /// - nothing attached → at once, `allowed-once` if `unanswered` is `allow`, else `unavailable`; nothing is
    ///   published;
    /// - `cancel` already resolved → `cancelled`, nothing published;
    /// - otherwise the request is registered as pending, published, and settled by the first of: an
    ///   [`ApprovalService::answer`] for its id (that outcome), `cancel` resolving (`cancelled`), or
    ///   `answer_timeout_ms` (`cancelled`). It leaves the pending list when settled; if an answer was accepted
    ///   (`answer` returned `true`) that answer is the outcome, even if a cancel raced it.
    ///
    /// `cancel` is any future: pass a cancellation token's `cancelled()` for a Stop, or
    /// `std::future::pending()` for none.
    pub async fn request<C>(&self, ask: ApprovalAsk, cancel: C) -> ApprovalOutcome
    where
        C: Future<Output = ()> + Send,
    {
        let _ = (
            ask,
            cancel,
            Duration::from_millis(self.config.answer_timeout_ms),
        );
        todo!("port request from src/approvals/service.ts")
    }

    /// Answer one waiting question (`answer`): `true` when it was waiting and is now settled with `answer`;
    /// `false` when the id is unknown or already settled (the route then answers 409, never 200).
    pub fn answer(&self, id: &str, answer: Answer) -> bool {
        let _ = (id, answer);
        todo!("remove the pending entry and send its outcome")
    }

    /// The decisions [`ApprovalService::check`] made in this process, in order (`history`).
    pub fn history(&self) -> Vec<DecisionRecord> {
        self.decisions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl EscalationApproval for ApprovalService {
    fn request<C>(
        &self,
        ask: ApprovalAsk,
        cancel: C,
    ) -> impl Future<Output = ApprovalOutcome> + Send
    where
        C: Future<Output = ()> + Send,
    {
        ApprovalService::request(self, ask, cancel)
    }
}

impl std::fmt::Debug for ApprovalService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalService")
            .field("config", &self.config)
            .field("answerers", &self.answerers.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}
