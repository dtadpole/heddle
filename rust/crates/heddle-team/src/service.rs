//! The **service layer**: durable teammates, a durable mailbox and a shared task board, over the Lead's log.
//!
//! Port of `src/team/service.ts` (DSH's `ctx.agentTeams` shape):
//!
//! - the **Lead is a session**; a teammate is a session of its own whose metadata names the team (`teamId`)
//!   and its parent, so a tool called inside a teammate's turn can find the journal;
//! - every mutation is a `team/*` event appended to the Lead's log and folded on read — nothing lives only in
//!   memory;
//! - a queued message is delivered by writing it into the **target's own log** (a steered user message when the
//!   target is mid-turn, the prompt of a new turn when idle) and confirming that write before
//!   `team/message/delivered` is journaled: the target's log is the proof, not the call returning;
//! - delivery is serialized per target, and mail to a member still provisioning is queued until it is active;
//! - interruption is the Lead's, and only stops the target's current turn — queued mail is untouched.
//!
//! **One Rust shape beyond the TypeScript one:** the TypeScript service was single-threaded, so "fold, check,
//! append" could not interleave. Here every journal write happens inside a per-Lead transaction that folds the
//! current log, validates the new event against it and appends it under one lock, so two concurrent tool calls
//! can never journal two `task-1`s or two members of one name — a log the fold would then refuse forever.
//!
//! Methods that start turns spawn the turn's remainder with `tokio::spawn`, so they must be called within a
//! Tokio runtime.

// Contract stage: the bodies below are `todo!()` until the service lands (port plan, step M2).
#![allow(unused_variables, dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::error::TeamResult;
use crate::ports::{TeamIds, TeamLive, TeamRunner, TeamStore, UuidIds};
use crate::state::{
    DEFAULT_MAX_MEMBERS, DEFAULT_MAX_TASKS, NewTask, SessionId, TeamMemberContext,
    TeamMemberSnapshot, TeamState, TeamTaskAction, TeamTaskView,
};

/// The team's caps. Defaults are the TypeScript build's: 8 members, 256 live tasks, 64 undelivered messages
/// per target, 65 536 bytes of message content (as JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamLimits {
    pub max_members: usize,
    pub max_tasks: usize,
    pub max_pending_messages_per_member: usize,
    pub max_message_bytes: usize,
}

impl Default for TeamLimits {
    fn default() -> Self {
        Self {
            max_members: DEFAULT_MAX_MEMBERS,
            max_tasks: DEFAULT_MAX_TASKS,
            max_pending_messages_per_member: 64,
            max_message_bytes: 65_536,
        }
    }
}

/// A callback that receives a Lead's session id: called after every journal write (`notify`).
pub type TeamNotify = Arc<dyn Fn(&str) + Send + Sync>;

/// A callback for a warning that must not stop the caller, e.g. a team boot recovery could not settle.
pub type TeamWarn = Arc<dyn Fn(&str) + Send + Sync>;

/// What the service is built over.
#[derive(Clone)]
pub struct TeamDeps {
    pub store: Arc<dyn TeamStore>,
    pub runner: Arc<dyn TeamRunner>,
    /// Optional: without it status is the durable phase only and `interrupt` is `TEAM_UNAVAILABLE`.
    pub live: Option<Arc<dyn TeamLive>>,
    pub limits: TeamLimits,
    /// Called after every journal write, so a Web UI or a policy writer can react.
    pub notify: Option<TeamNotify>,
    /// Where a recovery failure is reported; recovery must not stop a server from booting.
    pub warn: Option<TeamWarn>,
    pub ids: Arc<dyn TeamIds>,
}

impl TeamDeps {
    /// The required dependencies, with no live registry, default limits, no callbacks and UUID ids.
    pub fn new(store: Arc<dyn TeamStore>, runner: Arc<dyn TeamRunner>) -> Self {
        Self {
            store,
            runner,
            live: None,
            limits: TeamLimits::default(),
            notify: None,
            warn: None,
            ids: Arc::new(UuidIds),
        }
    }
}

/// A member's availability, from its durable phase and the live registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamMemberStatus {
    /// Active, with a turn in flight.
    Running,
    /// Active, no turn in flight. Says nothing about task completion.
    Inactive,
    Provisioning,
    Failed,
}

/// The role in a roster.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamRole {
    Lead,
    Teammate,
}

/// One roster entry, as `list_agents`, `spawn_teammate` and `/api/team` report it.
///
/// Serialized `{ id, name, role, status, description?, context?, diagnostics }`; the Lead's entry has no
/// description or context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamMemberView {
    pub id: SessionId,
    pub name: String,
    pub role: TeamRole,
    pub status: TeamMemberStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<TeamMemberContext>,
    /// The failure reason of a failed member; empty otherwise.
    pub diagnostics: Vec<String>,
}

/// A request to create one teammate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnRequest {
    pub name: String,
    pub description: String,
    /// The teammate's first prompt.
    pub prompt: String,
    pub context: TeamMemberContext,
}

/// A request to send one message.
#[derive(Debug, Clone, PartialEq)]
pub struct SendRequest {
    /// A member name or `lead`.
    pub target: String,
    /// Content parts, e.g. `[{ "type": "text", "text": "…" }]`.
    pub content: Vec<Value>,
}

/// Whether a sent message reached the target's own log yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SendStatus {
    /// In the target's own log — the only delivery the service believes.
    Accepted,
    /// Durable in the journal, not yet in the target's log (normally: the target is still provisioning).
    Queued,
}

/// The answer to a send, serialized `{ messageId, status }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub message_id: String,
    pub status: SendStatus,
}

/// The answer to a wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitResult {
    /// The journal changed after the wait began.
    Changed,
    /// Nothing changed before the timeout.
    TimedOut,
    /// No other member is running or provisioning, so nothing can change; answered at once.
    NoProgress,
}

/// The answer to an interrupt, serialized `{ previousStatus }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptOutcome {
    pub previous_status: TeamMemberStatus,
}

/// A task action as the service takes it: the caller is the session calling the service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskUpdate {
    pub task_id: String,
    pub revision: u64,
    pub action: TeamTaskAction,
    pub subject: Option<String>,
    pub description: Option<String>,
    pub blocked_by: Option<Vec<String>>,
    pub write_scopes: Option<Vec<String>>,
    pub owner_id: Option<SessionId>,
}

/// What recovering one team did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecoverReport {
    /// Provisioning members settled, as active or failed.
    pub settled: usize,
    /// Undelivered messages now in their target's log.
    pub delivered: usize,
}

/// What recovering every team in a store did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecoverAllReport {
    /// Teams recovered.
    pub recovered: usize,
    pub settled: usize,
    pub delivered: usize,
    /// Teams whose log the fold refused; each was reported through `warn` and skipped.
    pub failed: usize,
}

impl RecoverAllReport {
    /// The line the `web` command prints at boot, before its URL line, or `None` when there was nothing to
    /// recover: `heddle web: recovered N team(s) (S settled, D delivered[, F failed])`. The verifiers match it.
    pub fn boot_line(&self) -> Option<String> {
        if self.recovered == 0 && self.failed == 0 {
            return None;
        }
        let failed = if self.failed > 0 {
            format!(", {} failed", self.failed)
        } else {
            String::new()
        };
        Some(format!(
            "heddle web: recovered {} team(s) ({} settled, {} delivered{failed})",
            self.recovered, self.settled, self.delivered
        ))
    }
}

/// The Agent Teams service. Share it as `Arc<TeamService>`.
pub struct TeamService {
    deps: TeamDeps,
    /// Bumped after every journal write; a wait subscribes before it checks, so no write is missed.
    changes: tokio::sync::watch::Sender<u64>,
    /// One lock per Lead: fold, validate and append happen under it.
    transactions: Mutex<HashMap<SessionId, Arc<Mutex<()>>>>,
    /// One lock per target: two deliveries never race into the same log.
    dispatch: Mutex<HashMap<SessionId, Arc<tokio::sync::Mutex<()>>>>,
}

impl TeamService {
    pub fn new(deps: TeamDeps) -> Self {
        todo!("M2: port of the TeamService constructor (src/team/service.ts)")
    }

    /// The limits in force.
    pub fn limits(&self) -> TeamLimits {
        self.deps.limits
    }

    /// The Lead session a caller belongs to: itself when it is not a teammate, its team's Lead when it is.
    /// A teammate whose Lead session is missing is `TEAM_INVALID_EVENT`.
    pub fn lead_of(&self, caller: &str) -> TeamResult<SessionId> {
        todo!("M2: port of leadOf (src/team/service.ts)")
    }

    /// The folded team state of the Lead the caller belongs to.
    pub fn state(&self, caller: &str) -> TeamResult<TeamState> {
        todo!("M2: port of state (src/team/service.ts)")
    }

    /// The Lead, then every teammate in journal order, with live status.
    pub fn list(&self, caller: &str) -> TeamResult<Vec<TeamMemberView>> {
        todo!("M2: port of list (src/team/service.ts)")
    }

    /// Create one durable teammate (Lead only): journal it provisioning, create its own attributed session
    /// (fresh: with the Lead's cwd, endpoint and model; fork: from the Lead's completed turns), inherit the
    /// Lead's recorded mode, begin its first turn with a `team-prompt` source without awaiting it, then journal
    /// it active. A failure to create the session journals the member failed and returns the error.
    pub fn spawn(&self, caller: &str, request: SpawnRequest) -> TeamResult<TeamMemberView> {
        todo!("M2: port of spawn (src/team/service.ts)")
    }

    /// Queue one durable message and attempt delivery. A target still provisioning answers `queued`; otherwise
    /// delivery is attempted under the target's lock and answers `accepted` only when the target's own log
    /// holds the message. Refusals: an unknown or failed target, a message to oneself, a caller outside the
    /// team, a full mailbox, oversized content.
    pub async fn send(&self, caller: &str, request: SendRequest) -> TeamResult<SendOutcome> {
        todo!("M2: port of send and deliver (src/team/service.ts)")
    }

    /// The shared board, as views with readiness and advisory write-scope warnings.
    pub fn tasks(&self, caller: &str) -> TeamResult<Vec<TeamTaskView>> {
        todo!("M2: port of tasks (src/team/service.ts)")
    }

    /// Create one pending, unowned task and journal it.
    pub fn create_task(&self, caller: &str, input: NewTask) -> TeamResult<TeamTaskView> {
        todo!("M2: port of createTask (src/team/service.ts)")
    }

    /// Apply one compare-and-set action as the caller and journal the task's new revision.
    pub fn update_task(&self, caller: &str, update: TaskUpdate) -> TeamResult<TeamTaskView> {
        todo!("M2: port of updateTask (src/team/service.ts)")
    }

    /// Wait for the next journal write after this call began, the timeout, or the honest answer that nothing
    /// can change (no member other than the caller is running or provisioning). Never wakes anyone. Dropping
    /// the future cancels the wait.
    pub async fn wait_for_change(&self, caller: &str, timeout: Duration) -> TeamResult<WaitResult> {
        todo!("M2: port of waitForChange (src/team/service.ts)")
    }

    /// Interrupt one active teammate's current turn (Lead only). Queued mail is untouched.
    /// `TEAM_UNAVAILABLE` without a live registry.
    pub fn interrupt(&self, caller: &str, target_name: &str) -> TeamResult<InterruptOutcome> {
        todo!("M2: port of interrupt (src/team/service.ts)")
    }

    /// Reconcile what a previous process left in one team: settle each provisioning member from its durable
    /// child session (active when the child exists and holds a user message, failed otherwise), then offer
    /// every undelivered message to its target again.
    pub async fn recover(&self, lead: &str) -> TeamResult<RecoverReport> {
        todo!("M2: port of recover (src/team/service.ts)")
    }

    /// Recover every given session that carries team events. A team whose log the fold refuses is reported
    /// through `warn`, counted as failed, and skipped; the others are still recovered.
    pub async fn recover_all(&self, leads: &[SessionId]) -> RecoverAllReport {
        todo!("M2: port of recoverAll (src/team/service.ts)")
    }

    /// A member's status, from its durable phase and the live registry.
    pub fn status_of(&self, member: &TeamMemberSnapshot) -> TeamMemberStatus {
        todo!("M2: port of statusOf (src/team/service.ts)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_limits_are_the_typescript_ones() {
        assert_eq!(
            TeamLimits::default(),
            TeamLimits {
                max_members: 8,
                max_tasks: 256,
                max_pending_messages_per_member: 64,
                max_message_bytes: 65_536
            }
        );
    }

    #[test]
    fn the_boot_line_is_printed_only_when_a_team_was_recovered_or_failed() {
        assert_eq!(RecoverAllReport::default().boot_line(), None);
        let recovered = RecoverAllReport {
            recovered: 1,
            settled: 2,
            delivered: 1,
            failed: 0,
        };
        assert_eq!(
            recovered.boot_line().as_deref(),
            Some("heddle web: recovered 1 team(s) (2 settled, 1 delivered)")
        );
        let failed_only = RecoverAllReport {
            recovered: 0,
            settled: 0,
            delivered: 0,
            failed: 1,
        };
        assert_eq!(
            failed_only.boot_line().as_deref(),
            Some("heddle web: recovered 0 team(s) (0 settled, 0 delivered, 1 failed)")
        );
    }

    #[test]
    fn views_serialize_in_the_typescript_shape() {
        let lead = TeamMemberView {
            id: "session-a".into(),
            name: "lead".into(),
            role: TeamRole::Lead,
            status: TeamMemberStatus::Inactive,
            description: None,
            context: None,
            diagnostics: vec![],
        };
        assert_eq!(
            serde_json::to_string(&lead).unwrap(),
            r#"{"id":"session-a","name":"lead","role":"lead","status":"inactive","diagnostics":[]}"#
        );
        let sent = SendOutcome {
            message_id: "team-message-1".into(),
            status: SendStatus::Queued,
        };
        assert_eq!(
            serde_json::to_string(&sent).unwrap(),
            r#"{"messageId":"team-message-1","status":"queued"}"#
        );
        let interrupted = InterruptOutcome {
            previous_status: TeamMemberStatus::Running,
        };
        assert_eq!(
            serde_json::to_string(&interrupted).unwrap(),
            r#"{"previousStatus":"running"}"#
        );
    }
}
