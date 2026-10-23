//! The approval policy and the channel a person answers a question through.
//!
//! Ported from `src/approvals/service.ts`. Two jobs, one decision. The **standing policy** (`allow` / `deny` /
//! `ask`, tools named in `deny` and `allow`, and an `unanswered` answer for a run nobody can answer) decides
//! **whether** an action may be taken at all — a different refusal from the sandbox's **where**, and a person
//! needs to know which one stopped them. The **question** is what a tool asks before a wider action: an
//! answering surface attaches (the Web UI does on start), [`ApprovalService::request`] publishes the question
//! and waits, and [`ApprovalService::answer`] settles it. A headless run has no answerer, so it gets its
//! `unanswered` answer at once instead of hanging on a card nobody can see.

use std::collections::hash_map::RandomState;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    let Some(rest) = id.strip_prefix("approval-") else {
        return false;
    };
    rest.len() == 36
        && rest
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
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
        let decision = self.decide(tool);
        self.decisions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(DecisionRecord {
                tool: tool.to_owned(),
                allowed: decision.allowed,
                reason: decision.reason.clone(),
            });
        decision
    }

    /// The standing policy's answer, without recording it (`decide`).
    fn decide(&self, tool: &str) -> ApprovalDecision {
        let named = |names: &[String]| names.iter().any(|name| name == tool);
        if named(&self.config.deny) && !named(&self.config.allow) {
            return ApprovalDecision {
                allowed: false,
                mode: self.config.mode,
                reason: Some(format!("the approval policy denies '{tool}' by name")),
            };
        }
        match self.config.mode {
            ApprovalMode::Allow => ApprovalDecision {
                allowed: true,
                mode: ApprovalMode::Allow,
                reason: None,
            },
            ApprovalMode::Deny => {
                if named(&self.config.allow) {
                    ApprovalDecision {
                        allowed: true,
                        mode: ApprovalMode::Deny,
                        reason: Some(format!("'{tool}' is allowed by name")),
                    }
                } else {
                    ApprovalDecision {
                        allowed: false,
                        mode: ApprovalMode::Deny,
                        reason: Some(format!(
                            "the approval policy is 'deny' and '{tool}' is not allowed by name"
                        )),
                    }
                }
            }
            ApprovalMode::Ask => {
                if self.config.unanswered == Unanswered::Allow {
                    ApprovalDecision {
                        allowed: true,
                        mode: ApprovalMode::Ask,
                        reason: Some(format!(
                            "'{tool}' was not asked; unanswered defaults to allow"
                        )),
                    }
                } else {
                    ApprovalDecision {
                        allowed: false,
                        mode: ApprovalMode::Ask,
                        reason: Some(format!(
                            "the approval policy asks before '{tool}', and this run has no one to answer, so it is refused"
                        )),
                    }
                }
            }
        }
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
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|entry| entry.request.clone())
            .collect()
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
        if !self.can_answer() {
            return if self.config.unanswered == Unanswered::Allow {
                ApprovalOutcome::AllowedOnce
            } else {
                ApprovalOutcome::Unavailable
            };
        }
        // An ask that is already withdrawn settles at once and is never published, so a page cannot paint a card
        // for a call that is already over.
        let mut cancel = std::pin::pin!(cancel);
        {
            let waker = std::task::Waker::noop();
            let mut context = std::task::Context::from_waker(waker);
            if cancel.as_mut().poll(&mut context).is_ready() {
                return ApprovalOutcome::Cancelled;
            }
        }
        let display_reason = ask.display_reason.unwrap_or_else(|| ask.reason.clone());
        let request = ApprovalRequest {
            id: new_approval_id(),
            tool: ask.tool,
            reason: ask.reason,
            display_reason,
            session: ask.session,
            at: now_iso8601(),
        };
        let (settle, mut settled) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Pending {
                request: request.clone(),
                settle,
            });
        let _ = self.published.send(request.clone());

        // `biased` with the settlement first is the rule that an accepted answer beats a cancel that raced it:
        // an answer removes the pending entry, so the cancel branch's settle is a no-op when the answer won.
        tokio::select! {
            biased;
            answered = &mut settled => answered.unwrap_or(ApprovalOutcome::Cancelled),
            () = &mut cancel => {
                self.settle(&request.id, ApprovalOutcome::Cancelled);
                ApprovalOutcome::Cancelled
            }
            () = tokio::time::sleep(Duration::from_millis(self.config.answer_timeout_ms)) => {
                self.settle(&request.id, ApprovalOutcome::Cancelled);
                ApprovalOutcome::Cancelled
            }
        }
    }

    /// Answer one waiting question (`answer`): `true` when it was waiting and is now settled with `answer`;
    /// `false` when the id is unknown or already settled (the route then answers 409, never 200).
    pub fn answer(&self, id: &str, answer: Answer) -> bool {
        match self.take_pending(id) {
            Some(entry) => {
                let _ = entry.settle.send(answer.into());
                true
            }
            None => false,
        }
    }

    /// Settle a waiting question from inside the service (a Stop or the answer timeout).
    fn settle(&self, id: &str, outcome: ApprovalOutcome) {
        if let Some(entry) = self.take_pending(id) {
            let _ = entry.settle.send(outcome);
        }
    }

    /// Remove one pending entry, so the first settlement wins and later ones see nothing.
    fn take_pending(&self, id: &str) -> Option<Pending> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let position = pending.iter().position(|entry| entry.request.id == id)?;
        Some(pending.remove(position))
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

/// One `approval-<uuid v4>` id, from the process's own entropy sources — no extra crate for it.
fn new_approval_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0u8; 16];
    // `RandomState` is seeded from the OS once per instance, so the id does not depend on the clock alone.
    let state = RandomState::new();
    for chunk in bytes.chunks_mut(8) {
        let mut hasher = state.build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0),
        );
        let value = hasher.finish().to_be_bytes();
        chunk.copy_from_slice(&value[value.len() - chunk.len()..]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "approval-{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The current time as ISO 8601 UTC with milliseconds: `2026-10-23T01:16:42.123Z`.
fn now_iso8601() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    iso8601_millis(i64::try_from(millis).unwrap_or(i64::MAX))
}

/// [`now_iso8601`] over an explicit millisecond stamp, so the format is judged without the clock.
fn iso8601_millis(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let millis = millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Days since 1970-01-01 to a civil (year, month, day), by Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

impl std::fmt::Debug for ApprovalService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalService")
            .field("config", &self.config)
            .field("answerers", &self.answerers.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::oneshot;

    use super::{
        Answer, ApprovalAsk, ApprovalMode, ApprovalOutcome, ApprovalRequest, ApprovalService,
        ApprovalsConfig, Unanswered, civil_from_days, is_approval_id, iso8601_millis,
        new_approval_id,
    };

    fn ask(tool: &str) -> ApprovalAsk {
        ApprovalAsk {
            tool: tool.to_owned(),
            reason: "run the command".to_owned(),
            display_reason: Some("Allow this command: because the build needs it".to_owned()),
            session: Some("session-1".to_owned()),
        }
    }

    fn denying() -> ApprovalsConfig {
        ApprovalsConfig {
            mode: ApprovalMode::Deny,
            ..ApprovalsConfig::default()
        }
    }

    fn asking() -> ApprovalsConfig {
        ApprovalsConfig {
            mode: ApprovalMode::Ask,
            ..ApprovalsConfig::default()
        }
    }

    async fn wait_pending(service: &ApprovalService) -> ApprovalRequest {
        for _ in 0..2_000 {
            if let Some(request) = service.pending_requests().into_iter().next() {
                return request;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("the question was never published");
    }

    #[test]
    fn the_check_table_covers_every_mode_and_both_name_lists() {
        let allowed = ApprovalService::new(ApprovalsConfig::default());
        let decision = allowed.check("bash");
        assert!(decision.allowed);
        assert_eq!(decision.mode, ApprovalMode::Allow);
        assert_eq!(decision.reason, None);

        let named = ApprovalService::new(ApprovalsConfig {
            deny: vec!["bash".to_owned()],
            ..ApprovalsConfig::default()
        });
        let decision = named.check("bash");
        assert!(!decision.allowed);
        assert_eq!(
            decision.reason.as_deref(),
            Some("the approval policy denies 'bash' by name")
        );
        assert!(
            named.check("read_file").allowed,
            "only the named tool is denied"
        );

        let both = ApprovalService::new(ApprovalsConfig {
            deny: vec!["bash".to_owned()],
            allow: vec!["bash".to_owned()],
            ..ApprovalsConfig::default()
        });
        assert!(
            both.check("bash").allowed,
            "allow by name wins over deny by name, as in the TypeScript"
        );

        let deny_mode = ApprovalService::new(denying());
        let decision = deny_mode.check("read_file");
        assert!(!decision.allowed);
        assert_eq!(
            decision.reason.as_deref(),
            Some("the approval policy is 'deny' and 'read_file' is not allowed by name")
        );

        let deny_but_allowed = ApprovalService::new(ApprovalsConfig {
            allow: vec!["read_file".to_owned()],
            ..denying()
        });
        let decision = deny_but_allowed.check("read_file");
        assert!(decision.allowed);
        assert_eq!(
            decision.reason.as_deref(),
            Some("'read_file' is allowed by name")
        );

        let ask_deny = ApprovalService::new(asking());
        let decision = ask_deny.check("bash");
        assert!(!decision.allowed);
        assert_eq!(
            decision.reason.as_deref(),
            Some(
                "the approval policy asks before 'bash', and this run has no one to answer, so it is refused"
            )
        );

        let ask_allow = ApprovalService::new(ApprovalsConfig {
            unanswered: Unanswered::Allow,
            ..asking()
        });
        let decision = ask_allow.check("bash");
        assert!(decision.allowed);
        assert_eq!(
            decision.reason.as_deref(),
            Some("'bash' was not asked; unanswered defaults to allow")
        );
    }

    #[test]
    fn history_records_every_decision_in_order() {
        let service = ApprovalService::new(ApprovalsConfig {
            deny: vec!["bash".to_owned()],
            ..ApprovalsConfig::default()
        });
        service.check("bash");
        service.check("read_file");
        let history = service.history();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].tool, "bash");
        assert!(!history[0].allowed);
        assert_eq!(
            history[0].reason.as_deref(),
            Some("the approval policy denies 'bash' by name")
        );
        assert_eq!(history[1].tool, "read_file");
        assert!(history[1].allowed);
        assert_eq!(history[1].reason, None);
    }

    #[test]
    fn the_counted_guard_survives_an_overlapping_reload() {
        let service = ApprovalService::new(ApprovalsConfig::default());
        assert!(!service.can_answer(), "a headless run has no answerer");
        let old = service.attach_answerer();
        let new = service.attach_answerer();
        drop(old);
        assert!(
            service.can_answer(),
            "the reloaded answerer is still attached when the old guard drops"
        );
        new.detach();
        assert!(!service.can_answer());
    }

    #[tokio::test]
    async fn request_with_no_answerer_answers_from_unanswered_and_publishes_nothing() {
        let service = ApprovalService::new(ApprovalsConfig::default());
        let mut published = service.subscribe();
        let outcome = service.request(ask("bash"), std::future::pending()).await;
        assert_eq!(outcome, ApprovalOutcome::Unavailable);
        assert!(service.pending_requests().is_empty());
        assert!(published.try_recv().is_err(), "nothing was published");

        let allowing = ApprovalService::new(ApprovalsConfig {
            unanswered: Unanswered::Allow,
            ..ApprovalsConfig::default()
        });
        let outcome = allowing.request(ask("bash"), std::future::pending()).await;
        assert_eq!(outcome, ApprovalOutcome::AllowedOnce);
        assert!(allowing.pending_requests().is_empty());
    }

    #[tokio::test]
    async fn an_already_resolved_cancel_settles_at_once_and_publishes_nothing() {
        let service = ApprovalService::new(ApprovalsConfig::default());
        let _guard = service.attach_answerer();
        let mut published = service.subscribe();
        let outcome = service.request(ask("bash"), std::future::ready(())).await;
        assert_eq!(outcome, ApprovalOutcome::Cancelled);
        assert!(service.pending_requests().is_empty());
        assert!(published.try_recv().is_err(), "nothing was published");
    }

    #[tokio::test]
    async fn a_published_question_is_answered_once_and_leaves_the_pending_list() {
        let service = Arc::new(ApprovalService::new(ApprovalsConfig::default()));
        let _guard = service.attach_answerer();
        let mut published = service.subscribe();
        let worker = Arc::clone(&service);
        let handle = tokio::spawn(async move {
            worker
                .request(ask("bash"), std::future::pending::<()>())
                .await
        });

        let request = wait_pending(&service).await;
        assert!(
            is_approval_id(&request.id),
            "{} is an approval id",
            request.id
        );
        assert_eq!(request.tool, "bash");
        assert_eq!(request.reason, "run the command");
        assert_eq!(
            request.display_reason,
            "Allow this command: because the build needs it"
        );
        assert_eq!(request.session.as_deref(), Some("session-1"));
        assert!(request.at.ends_with('Z'), "at is UTC: {}", request.at);

        assert_eq!(
            published.recv().await.expect("the question is published"),
            request
        );
        assert!(service.answer(&request.id, Answer::AllowedOnce));
        assert_eq!(
            handle.await.expect("the request task"),
            ApprovalOutcome::AllowedOnce
        );
        assert!(service.pending_requests().is_empty());
        assert!(
            !service.answer(&request.id, Answer::Rejected),
            "a second answer is refused, so the route can answer 409"
        );
    }

    #[tokio::test]
    async fn a_cancel_while_waiting_settles_cancelled_and_empties_the_pending_list() {
        let service = Arc::new(ApprovalService::new(ApprovalsConfig::default()));
        let _guard = service.attach_answerer();
        let (withdraw, withdrawn) = oneshot::channel::<()>();
        let worker = Arc::clone(&service);
        let handle = tokio::spawn(async move {
            worker
                .request(ask("bash"), async move {
                    let _ = withdrawn.await;
                })
                .await
        });

        let _request = wait_pending(&service).await;
        withdraw.send(()).expect("the stop reaches the question");
        assert_eq!(
            handle.await.expect("the request task"),
            ApprovalOutcome::Cancelled
        );
        assert!(service.pending_requests().is_empty());
    }

    #[tokio::test]
    async fn the_answer_timeout_withdraws_the_question_as_cancelled() {
        let service = Arc::new(ApprovalService::new(ApprovalsConfig {
            answer_timeout_ms: 30,
            ..ApprovalsConfig::default()
        }));
        let _guard = service.attach_answerer();
        let worker = Arc::clone(&service);
        let handle = tokio::spawn(async move {
            worker
                .request(ask("bash"), std::future::pending::<()>())
                .await
        });

        let _request = wait_pending(&service).await;
        assert_eq!(
            handle.await.expect("the request task"),
            ApprovalOutcome::Cancelled
        );
        assert!(
            service.pending_requests().is_empty(),
            "a timed-out question is not left on a page"
        );
    }

    #[tokio::test]
    async fn an_accepted_answer_wins_over_a_later_cancel() {
        let service = Arc::new(ApprovalService::new(ApprovalsConfig::default()));
        let _guard = service.attach_answerer();
        let (withdraw, withdrawn) = oneshot::channel::<()>();
        let worker = Arc::clone(&service);
        let handle = tokio::spawn(async move {
            worker
                .request(ask("bash"), async move {
                    let _ = withdrawn.await;
                })
                .await
        });

        let request = wait_pending(&service).await;
        assert!(service.answer(&request.id, Answer::AllowedOnce));
        withdraw.send(()).expect("the stop reaches the question");
        assert_eq!(
            handle.await.expect("the request task"),
            ApprovalOutcome::AllowedOnce,
            "an answer that was accepted wins the race with a cancel"
        );
        assert!(service.pending_requests().is_empty());
    }

    #[test]
    fn an_approval_id_is_the_prefix_and_thirty_six_hex_or_dash_characters() {
        assert!(is_approval_id(
            "approval-0123456789abcdef0123456789abcdef0123"
        ));
        assert!(is_approval_id(
            "approval-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
        ));
        assert!(!is_approval_id("approval-abc"));
        assert!(
            !is_approval_id("approval-0123456789abcdef0123456789abcdef012"),
            "thirty-five characters is not an id"
        );
        assert!(
            !is_approval_id("approval-0123456789abcdef0123456789abcdef012g"),
            "g is not a hex digit"
        );
        assert!(!is_approval_id("0123456789abcdef0123456789abcdef0123"));
        let generated = new_approval_id();
        assert!(is_approval_id(&generated), "{generated}");
        assert_ne!(generated, new_approval_id(), "ids are not repeated");
    }

    #[test]
    fn a_generated_id_is_a_version_four_uuid() {
        let id = new_approval_id();
        let hex: String = id
            .trim_start_matches("approval-")
            .chars()
            .filter(|character| *character != '-')
            .collect();
        assert_eq!(hex.len(), 32);
        assert_eq!(hex.as_bytes()[12], b'4', "the version nibble");
        assert!(
            matches!(hex.as_bytes()[16], b'8' | b'9' | b'a' | b'b'),
            "the RFC 4122 variant nibble"
        );
        assert_eq!(id.len(), "approval-".len() + 36);
    }

    #[test]
    fn the_request_time_is_iso_8601_utc_with_milliseconds() {
        assert_eq!(iso8601_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601_millis(1_000), "1970-01-01T00:00:01.000Z");
        assert_eq!(iso8601_millis(999), "1970-01-01T00:00:00.999Z");
        assert_eq!(iso8601_millis(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            iso8601_millis(1_792_725_402_123),
            "2026-10-23T03:16:42.123Z",
            "the shape the server's log and the page both read"
        );
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_749), (2026, 10, 23));
    }

    #[test]
    fn the_request_json_uses_the_typescript_field_names() {
        let request = ApprovalRequest {
            id: "approval-0123456789abcdef0123456789abcdef0123".to_owned(),
            tool: "bash".to_owned(),
            reason: "audit reason".to_owned(),
            display_reason: "what a person reads".to_owned(),
            session: Some("session-1".to_owned()),
            at: "2026-10-23T01:16:42.123Z".to_owned(),
        };
        let value = serde_json::to_value(&request).expect("the request serialises");
        assert_eq!(value["displayReason"], json!("what a person reads"));
        assert_eq!(value["tool"], json!("bash"));
        assert_eq!(value["session"], json!("session-1"));
        assert!(
            value.get("display_reason").is_none(),
            "no snake_case key leaks"
        );

        let unowned = ApprovalRequest {
            session: None,
            ..request
        };
        let value = serde_json::to_value(&unowned).expect("the request serialises");
        assert!(
            value.get("session").is_none(),
            "an absent session is omitted"
        );
    }

    #[test]
    fn the_config_defaults_and_reads_camel_case() {
        let defaults: ApprovalsConfig = serde_json::from_value(json!({})).expect("an empty row");
        assert_eq!(defaults, ApprovalsConfig::default());
        assert_eq!(defaults.mode, ApprovalMode::Allow);
        assert_eq!(defaults.unanswered, Unanswered::Deny);
        assert_eq!(defaults.answer_timeout_ms, 300_000);

        let parsed: ApprovalsConfig = serde_json::from_value(json!({
            "mode": "ask",
            "deny": ["bash"],
            "allow": ["read_file"],
            "unanswered": "allow",
            "answerTimeoutMs": 1_000
        }))
        .expect("the row parses");
        assert_eq!(parsed.mode, ApprovalMode::Ask);
        assert_eq!(parsed.deny, vec!["bash".to_owned()]);
        assert_eq!(parsed.allow, vec!["read_file".to_owned()]);
        assert_eq!(parsed.unanswered, Unanswered::Allow);
        assert_eq!(parsed.answer_timeout_ms, 1_000);

        assert!(
            serde_json::from_value::<ApprovalsConfig>(json!({"mode": "maybe"})).is_err(),
            "a mode outside the vocabulary is refused"
        );
    }

    #[test]
    fn an_answer_parses_only_its_three_words() {
        assert_eq!(Answer::parse("allowed-once"), Some(Answer::AllowedOnce));
        assert_eq!(Answer::parse("rejected"), Some(Answer::Rejected));
        assert_eq!(Answer::parse("cancelled"), Some(Answer::Cancelled));
        assert_eq!(
            Answer::parse("unavailable"),
            None,
            "only the service concludes this one"
        );
        assert_eq!(Answer::parse("Allowed-Once"), None);
    }
}
