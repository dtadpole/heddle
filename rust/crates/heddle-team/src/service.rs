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

// Methods that start turns spawn the turn's remainder with `tokio::spawn`, so they must be called within a
// Tokio runtime.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{TeamError, TeamErrorCode, TeamResult};
use crate::ports::{ChildSession, TeamIds, TeamLive, TeamRunner, TeamSource, TeamStore, UuidIds};
use crate::state::{
    DEFAULT_MAX_MEMBERS, DEFAULT_MAX_TASKS, LEAD_NAME, NewTask, SessionId, TaskActionRequest,
    TeamEvent, TeamMemberContext, TeamMemberPhase, TeamMemberSnapshot, TeamMessageSnapshot,
    TeamState, TeamTaskAction, TeamTaskView, fold_team, is_team_event,
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
        let (changes, _receiver) = tokio::sync::watch::channel(0u64);
        Self {
            deps,
            changes,
            transactions: Mutex::new(HashMap::new()),
            dispatch: Mutex::new(HashMap::new()),
        }
    }

    /// The limits in force.
    pub fn limits(&self) -> TeamLimits {
        self.deps.limits
    }

    /// The Lead session a caller belongs to: itself when it is not a teammate, its team's Lead when it is.
    /// A teammate whose Lead session is missing is `TEAM_INVALID_EVENT`.
    pub fn lead_of(&self, caller: &str) -> TeamResult<SessionId> {
        match self.deps.store.meta(caller).and_then(|meta| meta.team_id) {
            None => Ok(caller.to_owned()),
            Some(team) => {
                if self.deps.store.exists(&team) {
                    Ok(team)
                } else {
                    Err(TeamError::new(
                        TeamErrorCode::InvalidEvent,
                        format!("team session '{team}' is missing"),
                    ))
                }
            }
        }
    }

    /// The folded team state of the Lead the caller belongs to.
    pub fn state(&self, caller: &str) -> TeamResult<TeamState> {
        let lead = self.lead_of(caller)?;
        fold_team(&self.deps.store.read(&lead)?, &lead)
    }

    /// The Lead, then every teammate in journal order, with live status.
    pub fn list(&self, caller: &str) -> TeamResult<Vec<TeamMemberView>> {
        let lead = self.lead_of(caller)?;
        let state = fold_team(&self.deps.store.read(&lead)?, &lead)?;
        let mut views = vec![TeamMemberView {
            id: lead.clone(),
            name: LEAD_NAME.to_owned(),
            role: TeamRole::Lead,
            status: if self.is_running(&lead) {
                TeamMemberStatus::Running
            } else {
                TeamMemberStatus::Inactive
            },
            description: None,
            context: None,
            diagnostics: Vec::new(),
        }];
        views.extend(state.members.iter().map(|member| self.view(member)));
        Ok(views)
    }

    /// Create one durable teammate (Lead only): journal it provisioning, create its own attributed session
    /// (fresh: with the Lead's cwd, endpoint and model; fork: from the Lead's completed turns), inherit the
    /// Lead's recorded mode, begin its first turn with a `team-prompt` source without awaiting it, then journal
    /// it active. A failure to create the session journals the member failed and returns the error.
    pub fn spawn(&self, caller: &str, request: SpawnRequest) -> TeamResult<TeamMemberView> {
        let lead = self.lead_of(caller)?;
        self.require_lead(caller, &lead)?;
        // Journal before the session exists, so a crash between the two leaves a provisioning member that
        // recovery can settle from the durable child rather than a member nobody knows about.
        let member = TeamMemberSnapshot {
            id: self.deps.ids.session_id(),
            name: request.name.clone(),
            description: request.description.clone(),
            context: request.context,
            phase: TeamMemberPhase::Provisioning,
            error: None,
        };
        self.transaction(&lead, |state| {
            state.add_member(member.clone(), self.deps.limits.max_members)?;
            self.journal(&lead, &TeamEvent::Member(member.clone()))
        })?;

        let lead_meta = self.deps.store.meta(&lead);
        let child = ChildSession {
            id: member.id.clone(),
            cwd: lead_meta.as_ref().and_then(|meta| meta.cwd.clone()),
            endpoint: lead_meta.as_ref().and_then(|meta| meta.endpoint.clone()),
            model: lead_meta.as_ref().and_then(|meta| meta.model.clone()),
            parent_session: lead.clone(),
            origin: "subagent",
            delegation_depth: 1,
            team_id: lead.clone(),
            title: format!("teammate {}", member.name),
        };
        let created: TeamResult<()> = match member.context {
            TeamMemberContext::Fork => match self.deps.store.fork(&lead, &child) {
                Ok(true) => Ok(()),
                Ok(false) => Err(TeamError::new(
                    TeamErrorCode::InvalidEvent,
                    format!("the Lead session '{lead}' could not be read to fork from"),
                )),
                Err(error) => Err(error.into()),
            },
            TeamMemberContext::Fresh => self.deps.store.create(&child).map_err(Into::into),
        };
        if let Err(error) = created {
            let _ = self.settle_failed(&lead, &member, &error.message);
            return Err(error);
        }
        // A teammate inherits the Lead's mode: a read-only team cannot spawn a teammate that writes.
        if let Err(error) = self.deps.store.inherit_recorded_mode(&lead, &member.id) {
            let _ = self.settle_failed(&lead, &member, &error.0);
            return Err(error.into());
        }
        let source = TeamSource::Prompt {
            team_id: lead.clone(),
            member_id: member.id.clone(),
        };
        // The first turn is started rather than awaited: a Lead that spawned a teammate keeps working.
        self.start_turn(&member.id, &request.prompt, &source);
        let active = TeamMemberSnapshot {
            phase: TeamMemberPhase::Active,
            error: None,
            ..member.clone()
        };
        self.transaction(&lead, |state| {
            state.add_member(active.clone(), self.deps.limits.max_members)?;
            self.journal(&lead, &TeamEvent::Member(active.clone()))
        })?;
        let state = self.state(&lead)?;
        let settled = state.member_by_id(&member.id).ok_or_else(|| {
            TeamError::new(
                TeamErrorCode::InvalidEvent,
                format!("member '{}' vanished after a journal write", member.id),
            )
        })?;
        Ok(self.view(settled))
    }

    /// Queue one durable message and attempt delivery. A target still provisioning answers `queued`; otherwise
    /// delivery is attempted under the target's lock and answers `accepted` only when the target's own log
    /// holds the message. Refusals: an unknown or failed target, a message to oneself, a caller outside the
    /// team, a full mailbox, oversized content.
    pub async fn send(&self, caller: &str, request: SendRequest) -> TeamResult<SendOutcome> {
        let lead = self.lead_of(caller)?;
        let (message, target_phase) = self.transaction(&lead, |state| {
            // A provisioning member is a valid target: its mail waits in the durable queue until it is active.
            // A failed member is not addressable, because nothing will ever take its mail.
            let (target_id, target_name, target_phase) = if request.target == LEAD_NAME {
                (lead.clone(), LEAD_NAME.to_owned(), TeamMemberPhase::Active)
            } else {
                let member = state
                    .member_by_name(&request.target)
                    .filter(|member| member.phase != TeamMemberPhase::Failed)
                    .ok_or_else(|| {
                        TeamError::new(
                            TeamErrorCode::MemberInvalid,
                            format!("no team member named '{}' can receive mail", request.target),
                        )
                    })?;
                (member.id.clone(), member.name.clone(), member.phase)
            };
            if target_id == caller {
                return Err(TeamError::new(
                    TeamErrorCode::SelfMessage,
                    "a team member cannot message itself",
                ));
            }
            let sender_name = if caller == lead {
                LEAD_NAME.to_owned()
            } else {
                state
                    .member_by_id(caller)
                    .map(|member| member.name.clone())
                    .ok_or_else(|| {
                        TeamError::new(
                            TeamErrorCode::MemberInvalid,
                            format!("session '{caller}' is not part of this team"),
                        )
                    })?
            };
            let pending = state.pending_for(&target_id);
            if pending >= self.deps.limits.max_pending_messages_per_member {
                return Err(TeamError::new(
                    TeamErrorCode::MailboxFull,
                    format!(
                        "member '{target_name}' has {pending} pending messages; max is {}",
                        self.deps.limits.max_pending_messages_per_member
                    ),
                ));
            }
            let bytes = serde_json::to_vec(&request.content)
                .map(|encoded| encoded.len())
                .unwrap_or(0);
            if bytes > self.deps.limits.max_message_bytes {
                return Err(TeamError::new(
                    TeamErrorCode::MessageTooLarge,
                    format!(
                        "the message exceeds {} bytes",
                        self.deps.limits.max_message_bytes
                    ),
                ));
            }
            let message = TeamMessageSnapshot {
                id: self.deps.ids.message_id(),
                sender_id: caller.to_owned(),
                sender_name,
                target_id,
                content: request.content.clone(),
            };
            state.queue_message(message.clone())?;
            self.journal(&lead, &TeamEvent::MessageQueued(message.clone()))?;
            Ok((message, target_phase))
        })?;

        if target_phase == TeamMemberPhase::Provisioning {
            return Ok(SendOutcome {
                message_id: message.id,
                status: SendStatus::Queued,
            });
        }
        let accepted = self.deliver_serialized(&lead, &message).await?;
        Ok(SendOutcome {
            message_id: message.id,
            status: if accepted {
                SendStatus::Accepted
            } else {
                SendStatus::Queued
            },
        })
    }

    /// The shared board, as views with readiness and advisory write-scope warnings.
    pub fn tasks(&self, caller: &str) -> TeamResult<Vec<TeamTaskView>> {
        let state = self.state(caller)?;
        Ok(state
            .tasks
            .iter()
            .map(|task| state.task_view(task))
            .collect())
    }

    /// Create one pending, unowned task and journal it.
    pub fn create_task(&self, caller: &str, input: NewTask) -> TeamResult<TeamTaskView> {
        let lead = self.lead_of(caller)?;
        self.transaction(&lead, |state| {
            let task = state.create_task(input, self.deps.limits.max_tasks)?;
            self.journal(&lead, &TeamEvent::Task(task.clone()))?;
            Ok(state.task_view(&task))
        })
    }

    /// Apply one compare-and-set action as the caller and journal the task's new revision.
    pub fn update_task(&self, caller: &str, update: TaskUpdate) -> TeamResult<TeamTaskView> {
        let lead = self.lead_of(caller)?;
        self.transaction(&lead, |state| {
            let request = TaskActionRequest {
                caller_id: caller.to_owned(),
                task_id: update.task_id,
                revision: update.revision,
                action: update.action,
                subject: update.subject,
                description: update.description,
                blocked_by: update.blocked_by,
                write_scopes: update.write_scopes,
                owner_id: update.owner_id,
            };
            let task = state.apply_task_action(&request)?;
            self.journal(&lead, &TeamEvent::Task(task.clone()))?;
            Ok(state.task_view(&task))
        })
    }

    /// Wait for the next journal write after this call began, the timeout, or the honest answer that nothing
    /// can change (no member other than the caller is running or provisioning). Never wakes anyone. Dropping
    /// the future cancels the wait.
    pub async fn wait_for_change(&self, caller: &str, timeout: Duration) -> TeamResult<WaitResult> {
        // Subscribe before folding: a write between the two must still count as a change after the call began.
        let mut changes = self.changes.subscribe();
        let lead = self.lead_of(caller)?;
        let state = fold_team(&self.deps.store.read(&lead)?, &lead)?;
        let can_progress = state.members.iter().any(|member| {
            member.id != caller
                && (member.phase == TeamMemberPhase::Provisioning || self.is_running(&member.id))
        });
        if !can_progress {
            return Ok(WaitResult::NoProgress);
        }
        match tokio::time::timeout(timeout, changes.changed()).await {
            Ok(Ok(())) => Ok(WaitResult::Changed),
            // The sender is owned by this service, so a closed channel is a timeout for this caller's purposes.
            Ok(Err(_)) | Err(_) => Ok(WaitResult::TimedOut),
        }
    }

    /// Interrupt one active teammate's current turn (Lead only). Queued mail is untouched.
    /// `TEAM_UNAVAILABLE` without a live registry.
    pub fn interrupt(&self, caller: &str, target_name: &str) -> TeamResult<InterruptOutcome> {
        let lead = self.lead_of(caller)?;
        self.require_lead(caller, &lead)?;
        let live = self.deps.live.as_ref().ok_or_else(|| {
            TeamError::new(
                TeamErrorCode::Unavailable,
                "this profile has no live-turn registry, so nothing can be interrupted",
            )
        })?;
        let state = fold_team(&self.deps.store.read(&lead)?, &lead)?;
        let target = state.member_by_name(target_name).ok_or_else(|| {
            TeamError::new(
                TeamErrorCode::MemberInvalid,
                format!("no team member named '{target_name}'"),
            )
        })?;
        if target.phase != TeamMemberPhase::Active {
            return Err(TeamError::new(
                TeamErrorCode::MemberInvalid,
                format!(
                    "member '{}' is {:?}, not running a turn",
                    target.name, target.phase
                ),
            ));
        }
        let previous_status = if live.is_running(&target.id) {
            TeamMemberStatus::Running
        } else {
            TeamMemberStatus::Inactive
        };
        live.abort(&target.id);
        Ok(InterruptOutcome { previous_status })
    }

    /// Reconcile what a previous process left in one team: settle each provisioning member from its durable
    /// child session (active when the child exists and holds a user message, failed otherwise), then offer
    /// every undelivered message to its target again.
    pub async fn recover(&self, lead: &str) -> TeamResult<RecoverReport> {
        let mut report = RecoverReport::default();
        let state = self.state(lead)?;
        let provisioning: Vec<TeamMemberSnapshot> = state
            .members
            .iter()
            .filter(|member| member.phase == TeamMemberPhase::Provisioning)
            .cloned()
            .collect();
        for member in provisioning {
            let accepted = self.deps.store.exists(&member.id)
                && self
                    .deps
                    .store
                    .read(&member.id)?
                    .iter()
                    .any(is_user_message);
            let settled = if accepted {
                TeamMemberSnapshot {
                    phase: TeamMemberPhase::Active,
                    error: None,
                    ..member.clone()
                }
            } else {
                TeamMemberSnapshot {
                    phase: TeamMemberPhase::Failed,
                    error: Some("provisioning did not leave a resumable child session".to_owned()),
                    ..member.clone()
                }
            };
            self.transaction(lead, |state| {
                state.add_member(settled.clone(), self.deps.limits.max_members)?;
                self.journal(lead, &TeamEvent::Member(settled.clone()))
            })?;
            report.settled += 1;
        }
        let state = self.state(lead)?;
        let undelivered: Vec<TeamMessageSnapshot> = state
            .messages
            .iter()
            .filter(|message| !state.is_delivered(&message.id))
            .cloned()
            .collect();
        for message in undelivered {
            if let Some(member) = state.member_by_id(&message.target_id)
                && member.phase != TeamMemberPhase::Active
            {
                continue;
            }
            if self.deliver_serialized(lead, &message).await? {
                report.delivered += 1;
            }
        }
        Ok(report)
    }

    /// Recover every given session that carries team events. A team whose log the fold refuses is reported
    /// through `warn`, counted as failed, and skipped; the others are still recovered.
    pub async fn recover_all(&self, leads: &[SessionId]) -> RecoverAllReport {
        let mut report = RecoverAllReport::default();
        for lead in leads {
            let events = match self.deps.store.read(lead) {
                Ok(events) => events,
                Err(error) => {
                    report.failed += 1;
                    self.warn(format!("team {lead} could not be recovered: {}", error.0));
                    continue;
                }
            };
            if !events.iter().any(is_team_event) {
                continue;
            }
            // One broken team must not keep a server from booting.
            match self.recover(lead).await {
                Ok(result) => {
                    report.recovered += 1;
                    report.settled += result.settled;
                    report.delivered += result.delivered;
                }
                Err(error) => {
                    report.failed += 1;
                    self.warn(format!(
                        "team {lead} could not be recovered: {}",
                        error.message
                    ));
                }
            }
        }
        report
    }

    /// A member's status, from its durable phase and the live registry.
    pub fn status_of(&self, member: &TeamMemberSnapshot) -> TeamMemberStatus {
        match member.phase {
            TeamMemberPhase::Failed => TeamMemberStatus::Failed,
            TeamMemberPhase::Provisioning => TeamMemberStatus::Provisioning,
            TeamMemberPhase::Active => {
                if self.is_running(&member.id) {
                    TeamMemberStatus::Running
                } else {
                    TeamMemberStatus::Inactive
                }
            }
        }
    }

    /// Whether the store has this session; the `/api/team` answer distinguishes a missing session (404) from a
    /// team whose log the fold refuses (500).
    pub(crate) fn session_exists(&self, session: &str) -> bool {
        self.deps.store.meta(session).is_some()
    }

    fn view(&self, member: &TeamMemberSnapshot) -> TeamMemberView {
        TeamMemberView {
            id: member.id.clone(),
            name: member.name.clone(),
            role: TeamRole::Teammate,
            status: self.status_of(member),
            description: Some(member.description.clone()),
            context: Some(member.context),
            diagnostics: member.error.iter().cloned().collect(),
        }
    }

    fn require_lead(&self, caller: &str, lead: &str) -> TeamResult<()> {
        if caller == lead {
            Ok(())
        } else {
            Err(TeamError::new(
                TeamErrorCode::LeadRequired,
                "only the Team Lead can do that",
            ))
        }
    }

    fn is_running(&self, session: &str) -> bool {
        self.deps
            .live
            .as_ref()
            .is_some_and(|live| live.is_running(session))
    }

    /// The per-Lead lock, created on first use.
    fn lead_lock(&self, lead: &str) -> Arc<Mutex<()>> {
        let mut transactions = self.transactions.lock().expect("the transactions lock");
        Arc::clone(transactions.entry(lead.to_owned()).or_default())
    }

    /// Fold, validate and append under one per-Lead lock. `change` sees a fresh fold and journals through
    /// [`Self::journal`]; nothing it refuses is ever appended.
    fn transaction<T>(
        &self,
        lead: &str,
        change: impl FnOnce(&mut TeamState) -> TeamResult<T>,
    ) -> TeamResult<T> {
        let lock = self.lead_lock(lead);
        let _guard = lock.lock().expect("a lead transaction lock");
        let mut state = fold_team(&self.deps.store.read(lead)?, lead)?;
        change(&mut state)
    }

    /// Append one already-validated event, then tell the profile and every waiter.
    fn journal(&self, lead: &str, event: &TeamEvent) -> TeamResult<()> {
        self.deps.store.append(lead, event.to_record(lead))?;
        if let Some(notify) = &self.deps.notify {
            notify(lead);
        }
        // Read the counter into a local first: holding the `borrow()` guard across `send_replace` would take
        // the same lock twice and deadlock.
        let next = self.changes.borrow().wrapping_add(1);
        self.changes.send_replace(next);
        Ok(())
    }

    /// Start a turn without awaiting it; a refused begin or a failed future is recorded as `turn/failed` in the
    /// member's own log, never thrown to the caller.
    fn start_turn(&self, session: &str, prompt: &str, source: &TeamSource) {
        match self.deps.runner.begin(session, prompt, source) {
            Ok(future) => {
                let store = Arc::clone(&self.deps.store);
                let session = session.to_owned();
                tokio::spawn(async move {
                    if let Err(reason) = future.await {
                        let _ = store
                            .append(&session, json!({ "type": "turn/failed", "reason": reason }));
                    }
                });
            }
            Err(reason) => {
                let _ = self
                    .deps
                    .store
                    .append(session, json!({ "type": "turn/failed", "reason": reason }));
            }
        }
    }

    /// Journal a failed member and report the failure for the caller; the error itself is returned by the caller.
    fn settle_failed(
        &self,
        lead: &str,
        member: &TeamMemberSnapshot,
        reason: &str,
    ) -> TeamResult<()> {
        let failed = TeamMemberSnapshot {
            phase: TeamMemberPhase::Failed,
            error: Some(reason.to_owned()),
            ..member.clone()
        };
        self.transaction(lead, |state| {
            state.add_member(failed.clone(), self.deps.limits.max_members)?;
            self.journal(lead, &TeamEvent::Member(failed.clone()))
        })
    }

    /// Deliver one queued message under the target's lock.
    async fn deliver_serialized(
        &self,
        lead: &str,
        message: &TeamMessageSnapshot,
    ) -> TeamResult<bool> {
        let lock = {
            let mut dispatch = self.dispatch.lock().expect("the dispatch lock");
            Arc::clone(dispatch.entry(message.target_id.clone()).or_default())
        };
        let _guard = lock.lock().await;
        self.deliver(lead, message)
    }

    /// Write the message into the target's own log (a steer mid-turn, a new turn when idle), then journal the
    /// delivery only once that log holds it. The target's log is the proof, not the call returning.
    fn deliver(&self, lead: &str, message: &TeamMessageSnapshot) -> TeamResult<bool> {
        if !self.deps.store.exists(&message.target_id) {
            return Ok(false);
        }
        if !self.recorded(&message.target_id, &message.id)? {
            let source = TeamSource::Message {
                team_id: lead.to_owned(),
                message_id: message.id.clone(),
                sender_id: message.sender_id.clone(),
                sender_name: message.sender_name.clone(),
            };
            if self.is_running(&message.target_id) {
                // Mid-turn: the loop notices new input between rounds, which is heddle's existing steering.
                self.deps.store.user_message(
                    &message.target_id,
                    message.content.clone(),
                    source.to_value(),
                )?;
            } else {
                let prompt = text_of(&message.content);
                self.start_turn(&message.target_id, &prompt, &source);
            }
        }
        if !self.recorded(&message.target_id, &message.id)? {
            return Ok(false);
        }
        self.transaction(lead, |state| {
            if state.is_delivered(&message.id) {
                return Ok(());
            }
            state.mark_delivered(&message.id, &message.target_id)?;
            self.journal(
                lead,
                &TeamEvent::MessageDelivered {
                    message_id: message.id.clone(),
                    target_id: message.target_id.clone(),
                },
            )
        })?;
        Ok(true)
    }

    /// Is this message in the target's own log? The only delivery proof this service accepts.
    fn recorded(&self, session: &str, message_id: &str) -> TeamResult<bool> {
        let events = self.deps.store.read(session)?;
        Ok(events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("message")
                && message_field(event, "role").and_then(Value::as_str) == Some("user")
                && message_field(event, "source")
                    .and_then(|source| source.get("kind"))
                    .and_then(Value::as_str)
                    == Some(TeamSource::MESSAGE_KIND)
                && message_field(event, "source")
                    .and_then(|source| source.get("messageId"))
                    .and_then(Value::as_str)
                    == Some(message_id)
        }))
    }

    fn warn(&self, message: String) {
        if let Some(warn) = &self.deps.warn {
            warn(&message);
        }
    }
}

/// One field of the `message` object of a `message` log event.
fn message_field<'a>(event: &'a Value, field: &str) -> Option<&'a Value> {
    event.get("message").and_then(|message| message.get(field))
}

/// Whether a log event is a user message; recovery settles a provisioning member on one.
fn is_user_message(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("message")
        && message_field(event, "role").and_then(Value::as_str) == Some("user")
}

/// The text of a content-part list, one text part per line, as the TypeScript build joined it.
fn text_of(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|part| {
            (part.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| part.get("text").and_then(Value::as_str))
                .flatten()
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
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

    // --- M2: the doubles and the service ---

    use crate::ports::SessionMetaView;
    use crate::state::TeamTaskStatus;
    use crate::testing::{FakeLive, MemoryStore, RecordingRunner, SequentialIds};

    struct Harness {
        store: Arc<MemoryStore>,
        lead: SessionId,
        live: Arc<FakeLive>,
        runner: Arc<RecordingRunner>,
        service: Arc<TeamService>,
        warnings: Arc<Mutex<Vec<String>>>,
    }

    fn harness_with(limits: TeamLimits, with_live: bool) -> Harness {
        let store = Arc::new(MemoryStore::new());
        let lead: SessionId = "session-lead".to_owned();
        store.add_session(SessionMetaView {
            id: lead.clone(),
            cwd: Some("/work".to_owned()),
            endpoint: Some("scripted".to_owned()),
            model: Some("m".to_owned()),
            team_id: None,
        });
        let live = Arc::new(FakeLive::new());
        // The runner does not register turns live here: a test controls the registry explicitly, the way the
        // TypeScript suite did, so "running" is never a race against a spawned future.
        let runner = Arc::new(RecordingRunner::new(Arc::clone(&store), None));
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let warn: TeamWarn = {
            let warnings = Arc::clone(&warnings);
            Arc::new(move |message: &str| {
                warnings
                    .lock()
                    .expect("the warnings lock")
                    .push(message.to_owned());
            })
        };
        let store_dependency: Arc<dyn TeamStore> = store.clone();
        let runner_dependency: Arc<dyn TeamRunner> = runner.clone();
        let live_dependency: Option<Arc<dyn TeamLive>> =
            with_live.then(|| Arc::clone(&live) as Arc<dyn TeamLive>);
        let service = Arc::new(TeamService::new(TeamDeps {
            store: store_dependency,
            runner: runner_dependency,
            live: live_dependency,
            limits,
            notify: None,
            warn: Some(warn),
            ids: Arc::new(SequentialIds::new()),
        }));
        Harness {
            store,
            lead,
            live,
            runner,
            service,
            warnings,
        }
    }

    fn harness() -> Harness {
        harness_with(TeamLimits::default(), true)
    }

    fn spawn_request(name: &str, prompt: &str) -> SpawnRequest {
        SpawnRequest {
            name: name.to_owned(),
            description: "x".to_owned(),
            prompt: prompt.to_owned(),
            context: TeamMemberContext::Fresh,
        }
    }

    fn child_of(team: &str, id: &str) -> ChildSession {
        ChildSession {
            id: id.to_owned(),
            cwd: Some("/work".to_owned()),
            endpoint: None,
            model: None,
            parent_session: team.to_owned(),
            origin: "subagent",
            delegation_depth: 1,
            team_id: team.to_owned(),
            title: "teammate".to_owned(),
        }
    }

    fn child(id: &str) -> ChildSession {
        child_of("session-lead", id)
    }

    fn add_provisioning(h: &Harness, id: &str, name: &str) {
        h.store
            .create(&child_of(&h.lead, id))
            .expect("the child session is created");
        h.store
            .append(
                &h.lead,
                json!({
                    "type": "team/member",
                    "version": 2,
                    "teamId": h.lead,
                    "member": { "id": id, "name": name, "description": "x", "context": "fresh", "phase": "provisioning" },
                }),
            )
            .expect("the provisioning member is journaled");
    }

    async fn send_error(h: &Harness, caller: &str, target: &str) -> TeamErrorCode {
        h.service
            .send(
                caller,
                SendRequest {
                    target: target.to_owned(),
                    content: vec![json!({ "type": "text", "text": "hello" })],
                },
            )
            .await
            .expect_err("the send is refused")
            .code
    }

    #[tokio::test]
    async fn spawn_creates_an_attributed_session_and_journals_it_provisioning_then_active() {
        let h = harness();
        let view = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "start working"))
            .expect("the spawn succeeds");
        assert_eq!(view.name, "alpha");
        assert_eq!(view.role, TeamRole::Teammate);
        assert_eq!(view.status, TeamMemberStatus::Inactive);
        let stored = h.store.session(&view.id).expect("the child exists");
        let attribution = stored
            .child
            .as_ref()
            .expect("the child carries its attribution");
        assert_eq!(attribution.parent_session, h.lead);
        assert_eq!(attribution.origin, "subagent");
        assert_eq!(attribution.delegation_depth, 1);
        assert_eq!(attribution.team_id, h.lead);
        assert_eq!(attribution.title, "teammate alpha");
        assert_eq!(
            attribution.cwd.as_deref(),
            Some("/work"),
            "a fresh teammate takes the Lead's cwd"
        );
        assert_eq!(stored.meta.team_id.as_deref(), Some(h.lead.as_str()));
        assert!(
            h.store.events(&view.id).iter().any(is_user_message),
            "the initial prompt is durable in the child log"
        );
        let phases: Vec<String> = h
            .store
            .events(&h.lead)
            .iter()
            .filter(|event| event["type"] == "team/member")
            .map(|event| {
                event["member"]["phase"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect();
        assert_eq!(phases, vec!["provisioning".to_owned(), "active".to_owned()]);
        assert_eq!(
            h.service.state(&h.lead).unwrap().members[0].phase,
            TeamMemberPhase::Active
        );
        let begun = h.runner.begun();
        assert_eq!(begun.len(), 1);
        assert_eq!(begun[0].prompt, "start working");
        assert_eq!(begun[0].source["kind"], "team-prompt");
        assert_eq!(begun[0].source["memberId"], view.id);
    }

    #[tokio::test]
    async fn only_the_lead_may_spawn_and_a_teammate_cannot_spawn_a_peer() {
        let h = harness();
        let alpha = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        assert_eq!(
            h.service
                .spawn(&alpha.id, spawn_request("beta", "go"))
                .expect_err("a teammate cannot spawn")
                .code,
            TeamErrorCode::LeadRequired
        );
    }

    #[tokio::test]
    async fn spawn_honours_max_members_and_a_failed_spawn_settles_the_member_failed() {
        let limited = harness_with(
            TeamLimits {
                max_members: 1,
                ..TeamLimits::default()
            },
            true,
        );
        limited
            .service
            .spawn(&limited.lead, spawn_request("alpha", "go"))
            .unwrap();
        assert_eq!(
            limited
                .service
                .spawn(&limited.lead, spawn_request("beta", "go"))
                .expect_err("the cap is enforced")
                .code,
            TeamErrorCode::Limit
        );

        let h = harness();
        h.store.fail_creates(Some("disk is full"));
        let error = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .expect_err("the session cannot be created");
        assert!(error.message.contains("disk is full"), "{}", error.message);
        let state = h.service.state(&h.lead).unwrap();
        assert_eq!(state.members[0].phase, TeamMemberPhase::Failed);
        assert!(
            state.members[0]
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("disk is full")
        );
    }

    #[tokio::test]
    async fn a_fork_teammate_starts_from_the_leads_history_and_a_fresh_one_does_not() {
        let h = harness();
        h.store
            .user_message(
                &h.lead,
                vec![json!({ "type": "text", "text": "earlier work" })],
                json!({ "kind": "user" }),
            )
            .unwrap();
        let fresh = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        let forked = h
            .service
            .spawn(
                &h.lead,
                SpawnRequest {
                    context: TeamMemberContext::Fork,
                    ..spawn_request("beta", "go")
                },
            )
            .unwrap();
        assert!(
            !h.store
                .events(&fresh.id)
                .iter()
                .any(|event| event.to_string().contains("earlier work")),
            "a fresh teammate does not inherit"
        );
        assert!(
            h.store
                .events(&forked.id)
                .iter()
                .any(|event| event.to_string().contains("earlier work")),
            "a forked teammate inherits the Lead history"
        );
    }

    #[tokio::test]
    async fn sending_to_an_idle_teammate_starts_a_turn_and_delivery_is_proven_by_the_target_log() {
        let h = harness();
        let alpha = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        let before = h.runner.begun().len();
        let sent = h
            .service
            .send(
                &h.lead,
                SendRequest {
                    target: "alpha".to_owned(),
                    content: vec![json!({ "type": "text", "text": "do the next thing" })],
                },
            )
            .await
            .unwrap();
        assert_eq!(sent.status, SendStatus::Accepted);
        let begun = h.runner.begun();
        assert_eq!(
            begun.len(),
            before + 1,
            "the idle teammate was given a turn"
        );
        assert_eq!(begun.last().unwrap().prompt, "do the next thing");
        let events = h.store.events(&alpha.id);
        let delivered: Vec<&Value> = events
            .iter()
            .filter(|event| event["message"]["source"]["kind"] == "team-message")
            .collect();
        assert_eq!(delivered.len(), 1);
        assert_eq!(
            delivered[0]["message"]["source"]["messageId"],
            sent.message_id
        );
        let state = h.service.state(&h.lead).unwrap();
        assert_eq!(state.delivered, vec![sent.message_id.clone()]);
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].sender_name, "lead");
    }

    #[tokio::test]
    async fn mail_to_a_provisioning_member_is_queued_then_delivered_when_recover_settles_it() {
        let h = harness();
        add_provisioning(&h, "session-member-beta", "beta");
        h.store
            .user_message(
                "session-member-beta",
                vec![json!({ "type": "text", "text": "warm-up" })],
                json!({ "kind": "user" }),
            )
            .unwrap();
        let sent = h
            .service
            .send(
                &h.lead,
                SendRequest {
                    target: "beta".to_owned(),
                    content: vec![json!({ "type": "text", "text": "later" })],
                },
            )
            .await
            .unwrap();
        assert_eq!(
            sent.status,
            SendStatus::Queued,
            "a provisioning member has no turn to deliver into"
        );
        assert!(h.service.state(&h.lead).unwrap().delivered.is_empty());
        let recovered = h.service.recover(&h.lead).await.unwrap();
        assert_eq!(recovered.settled, 1);
        assert_eq!(recovered.delivered, 1);
        let state = h.service.state(&h.lead).unwrap();
        assert_eq!(state.members[0].phase, TeamMemberPhase::Active);
        assert_eq!(state.delivered, vec![sent.message_id]);
    }

    #[tokio::test]
    async fn recover_fails_a_provisioning_member_whose_child_never_accepted_a_prompt() {
        let h = harness();
        h.store.create(&child("session-ghost")).unwrap();
        h.store
            .append(
                &h.lead,
                json!({
                    "type": "team/member",
                    "version": 2,
                    "teamId": h.lead,
                    "member": { "id": "session-ghost", "name": "ghost", "description": "x", "context": "fresh", "phase": "provisioning" },
                }),
            )
            .unwrap();
        // A second member whose child was never created at all.
        h.store
            .append(
                &h.lead,
                json!({
                    "type": "team/member",
                    "version": 2,
                    "teamId": h.lead,
                    "member": { "id": "session-nothing", "name": "nothing", "description": "x", "context": "fresh", "phase": "provisioning" },
                }),
            )
            .unwrap();
        let recovered = h.service.recover(&h.lead).await.unwrap();
        assert_eq!(recovered.settled, 2);
        let state = h.service.state(&h.lead).unwrap();
        assert!(
            state
                .members
                .iter()
                .all(|member| member.phase == TeamMemberPhase::Failed)
        );
        assert!(
            state.members[0]
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("resumable child session")
        );
    }

    #[tokio::test]
    async fn self_messages_unknown_targets_a_stray_caller_and_the_caps_are_refusals() {
        let h = harness();
        h.service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        assert_eq!(
            send_error(&h, &h.lead, "lead").await,
            TeamErrorCode::SelfMessage
        );
        assert_eq!(
            send_error(&h, &h.lead, "nobody").await,
            TeamErrorCode::MemberInvalid
        );

        // A session attributed to the team but with no member snapshot cannot send.
        h.store.add_session(SessionMetaView {
            id: "session-stray".to_owned(),
            cwd: Some("/work".to_owned()),
            team_id: Some(h.lead.clone()),
            ..SessionMetaView::default()
        });
        assert_eq!(
            send_error(&h, "session-stray", "lead").await,
            TeamErrorCode::MemberInvalid
        );

        let tiny = harness_with(
            TeamLimits {
                max_message_bytes: 4,
                ..TeamLimits::default()
            },
            true,
        );
        tiny.service
            .spawn(&tiny.lead, spawn_request("alpha", "go"))
            .unwrap();
        assert_eq!(
            send_error(&tiny, &tiny.lead, "alpha").await,
            TeamErrorCode::MessageTooLarge
        );

        let full = harness_with(
            TeamLimits {
                max_pending_messages_per_member: 0,
                ..TeamLimits::default()
            },
            true,
        );
        full.service
            .spawn(&full.lead, spawn_request("alpha", "go"))
            .unwrap();
        assert_eq!(
            send_error(&full, &full.lead, "alpha").await,
            TeamErrorCode::MailboxFull
        );
    }

    #[tokio::test]
    async fn the_task_board_goes_through_the_service_with_journaling_and_revision_checks() {
        let h = harness();
        h.service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        let created = h
            .service
            .create_task(
                &h.lead,
                NewTask {
                    subject: "write the thing".to_owned(),
                    ..NewTask::default()
                },
            )
            .unwrap();
        assert_eq!(created.id, "task-1");
        assert_eq!(created.status, TeamTaskStatus::Pending);
        let update = |action, revision| TaskUpdate {
            task_id: "task-1".to_owned(),
            revision,
            action,
            subject: None,
            description: None,
            blocked_by: None,
            write_scopes: None,
            owner_id: None,
        };
        let claimed = h
            .service
            .update_task(&h.lead, update(TeamTaskAction::Claim, 1))
            .unwrap();
        assert_eq!(claimed.status, TeamTaskStatus::InProgress);
        assert_eq!(claimed.owner_name.as_deref(), Some("lead"));
        assert_eq!(
            h.service
                .update_task(&h.lead, update(TeamTaskAction::Complete, 1))
                .expect_err("the revision is stale")
                .code,
            TeamErrorCode::TaskStale
        );
        let completed = h
            .service
            .update_task(&h.lead, update(TeamTaskAction::Complete, 2))
            .unwrap();
        assert_eq!(completed.status, TeamTaskStatus::Completed);
        let revisions: Vec<u64> = h
            .store
            .events(&h.lead)
            .iter()
            .filter(|event| event["type"] == "team/task")
            .map(|event| event["task"]["revision"].as_u64().unwrap_or_default())
            .collect();
        assert_eq!(
            revisions,
            vec![1, 2, 3],
            "every change is journaled as a whole revision"
        );
    }

    #[tokio::test]
    async fn status_comes_from_the_durable_phase_and_the_live_turn_registry() {
        let h = harness();
        let alpha = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        h.live.set_running(&alpha.id, true);
        let status = |h: &Harness, name: &str| {
            h.service
                .list(&h.lead)
                .unwrap()
                .into_iter()
                .find(|view| view.name == name)
                .unwrap()
                .status
        };
        assert_eq!(status(&h, "alpha"), TeamMemberStatus::Running);
        h.live.set_running(&alpha.id, false);
        assert_eq!(status(&h, "alpha"), TeamMemberStatus::Inactive);
        h.live.set_running(&h.lead, true);
        assert_eq!(status(&h, "lead"), TeamMemberStatus::Running);
    }

    #[tokio::test]
    async fn wait_is_level_triggered() {
        let idle = harness();
        idle.service
            .spawn(&idle.lead, spawn_request("alpha", "go"))
            .unwrap();
        assert_eq!(
            idle.service
                .wait_for_change(&idle.lead, Duration::from_millis(10))
                .await
                .unwrap(),
            WaitResult::NoProgress
        );

        let h = harness();
        add_provisioning(&h, "session-member-beta", "beta");
        let service = Arc::clone(&h.service);
        let lead = h.lead.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            service
                .create_task(
                    &lead,
                    NewTask {
                        subject: "wake up".to_owned(),
                        ..NewTask::default()
                    },
                )
                .unwrap();
        });
        assert_eq!(
            h.service
                .wait_for_change(&h.lead, Duration::from_millis(500))
                .await
                .unwrap(),
            WaitResult::Changed
        );
        assert_eq!(
            h.service
                .wait_for_change(&h.lead, Duration::from_millis(20))
                .await
                .unwrap(),
            WaitResult::TimedOut
        );
    }

    #[tokio::test]
    async fn interrupt_is_lead_only_and_stops_the_targets_turn_without_touching_its_mail() {
        let h = harness();
        let alpha = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        h.live.set_running(&alpha.id, true);
        let sent = h
            .service
            .send(
                &h.lead,
                SendRequest {
                    target: "alpha".to_owned(),
                    content: vec![json!({ "type": "text", "text": "one" })],
                },
            )
            .await
            .unwrap();
        assert_eq!(
            sent.status,
            SendStatus::Accepted,
            "mid-turn delivery is a steer"
        );
        assert_eq!(
            h.service
                .interrupt(&alpha.id, "alpha")
                .expect_err("a teammate cannot interrupt")
                .code,
            TeamErrorCode::LeadRequired
        );
        let result = h.service.interrupt(&h.lead, "alpha").unwrap();
        assert_eq!(result.previous_status, TeamMemberStatus::Running);
        assert_eq!(h.live.aborted(), vec![alpha.id.clone()]);
        assert_eq!(
            h.service.state(&h.lead).unwrap().messages.len(),
            1,
            "the inbox is untouched by an interrupt"
        );
        assert_eq!(
            h.service
                .interrupt(&h.lead, "nobody")
                .expect_err("an unknown target")
                .code,
            TeamErrorCode::MemberInvalid
        );

        let unavailable = harness_with(TeamLimits::default(), false);
        unavailable
            .service
            .spawn(&unavailable.lead, spawn_request("alpha", "go"))
            .unwrap();
        assert_eq!(
            unavailable
                .service
                .interrupt(&unavailable.lead, "alpha")
                .expect_err("no live registry")
                .code,
            TeamErrorCode::Unavailable
        );
    }

    #[tokio::test]
    async fn a_teammate_can_message_its_lead_through_the_same_mailbox() {
        let h = harness();
        let alpha = h
            .service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();
        let sent = h
            .service
            .send(
                &alpha.id,
                SendRequest {
                    target: "lead".to_owned(),
                    content: vec![json!({ "type": "text", "text": "reporting in" })],
                },
            )
            .await
            .unwrap();
        assert_eq!(sent.status, SendStatus::Accepted);
        assert!(
            h.store
                .events(&h.lead)
                .iter()
                .any(|event| event.to_string().contains("reporting in")),
            "the Lead's own log accepted the message"
        );
        assert_eq!(h.service.lead_of(&alpha.id).unwrap(), h.lead);
        assert_eq!(
            h.service.state(&h.lead).unwrap().messages[0].sender_name,
            "alpha"
        );
    }

    #[tokio::test]
    async fn a_corrupt_team_is_reported_by_recover_all_and_does_not_stop_the_healthy_ones() {
        let h = harness();
        let broken = "session-broken".to_owned();
        h.store.add_session(SessionMetaView {
            id: broken.clone(),
            cwd: Some("/work".to_owned()),
            ..SessionMetaView::default()
        });
        h.store
            .create(&child_of(&broken, "session-broken-child"))
            .unwrap();
        // A member that is active without ever being provisioning: the fold refuses it.
        h.store
            .append(
                &broken,
                json!({
                    "type": "team/member",
                    "version": 2,
                    "teamId": broken,
                    "member": { "id": "session-broken-child", "name": "broken", "description": "x", "context": "fresh", "phase": "active" },
                }),
            )
            .unwrap();
        h.service
            .spawn(&h.lead, spawn_request("alpha", "go"))
            .unwrap();

        let recovered = h
            .service
            .recover_all(&[broken.clone(), h.lead.clone()])
            .await;
        assert_eq!(recovered.failed, 1, "the corrupt team is counted as failed");
        assert_eq!(
            recovered.recovered, 1,
            "the healthy team was still recovered"
        );
        {
            let warnings = h.warnings.lock().unwrap();
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("must start provisioning"));
        }

        let empty = h.service.recover_all(&[]).await;
        assert_eq!(
            empty.recovered + empty.settled + empty.delivered + empty.failed,
            0
        );
    }

    #[test]
    fn two_concurrent_task_creations_journal_two_distinct_ids() {
        let h = harness();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let service = Arc::clone(&h.service);
            let lead = h.lead.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                service.create_task(
                    &lead,
                    NewTask {
                        subject: "concurrent".to_owned(),
                        ..NewTask::default()
                    },
                )
            }));
        }
        let mut ids: Vec<String> = handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .expect("the thread runs")
                    .expect("the task is created")
                    .id
            })
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["task-1".to_owned(), "task-2".to_owned()]);
        let state = h.service.state(&h.lead).unwrap();
        assert_eq!(state.tasks.len(), 2);
        assert!(state.tasks.iter().all(|task| task.revision == 1));
    }
}
