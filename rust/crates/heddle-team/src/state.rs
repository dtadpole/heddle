//! The **pure layer**: team events, the strict fold, member lifecycle, the task board with revision
//! compare-and-set, readiness and advisory write scopes, and the mailbox ledger.
//!
//! Port of `src/team/state.ts`. No service, no model, no filesystem: the Lead session's log is the only input
//! and the fold is the only reader, which is what makes the state restartable and testable without a turn.
//!
//! **Strictness is the contract.** A member snapshot whose phase and error disagree, a task revision that skips
//! a step, a message delivered twice, a foreign `teamId`, an unknown record version or a blocker cycle fails the
//! fold loudly instead of producing a state that silently means something else.
//!
//! Every mutating method validates completely before it changes anything, so a refused event leaves the state
//! as it was.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{TeamError, TeamErrorCode, TeamResult};

/// A session id, `session-<uuid>`. The team is identified by its Lead's session id.
pub type SessionId = String;

/// The record version every `team/*` event carries; the fold refuses any other.
pub const TEAM_EVENT_VERSION: u64 = 2;

/// The name the Lead is addressed by. It is never a member snapshot.
pub const LEAD_NAME: &str = "lead";

/// The member cap the fold applies, and the service's default `maxMembers`.
pub const DEFAULT_MAX_MEMBERS: usize = 8;

/// The live-task cap a task creation applies by default (`maxTasks`).
pub const DEFAULT_MAX_TASKS: usize = 256;

/// Where a member is in its one-way lifecycle: provisioning, then active or failed, once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamMemberPhase {
    Provisioning,
    Active,
    Failed,
}

/// How a teammate's session starts: empty, or from the Lead's completed turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamMemberContext {
    #[default]
    Fresh,
    Fork,
}

/// A task's status on the board.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamTaskStatus {
    Pending,
    InProgress,
    Completed,
    Deleted,
}

/// One compare-and-set action on a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamTaskAction {
    Claim,
    Release,
    Edit,
    SetDependencies,
    Complete,
    Reopen,
    /// Lead-only.
    Reassign,
    Delete,
}

/// One member as the journal records it. The Lead is never a member.
///
/// Serialized as the TypeScript build writes it: `{ id, name, description, context, phase, error? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamMemberSnapshot {
    /// The teammate's own session id; never the Lead's.
    pub id: SessionId,
    /// Lower-kebab-case and unique in the team. (The TypeScript build does not reserve `lead`; a member so
    /// named is shadowed by the Lead in name resolution — kept as is, see the port plan's open questions.)
    pub name: String,
    /// What the member is responsible for; never blank.
    pub description: String,
    pub context: TeamMemberContext,
    pub phase: TeamMemberPhase,
    /// Present exactly when `phase` is `failed`, and then non-empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One complete task snapshot; every action journals the whole task at its next revision.
///
/// Serialized as `{ id, revision, subject, description, status, blockedBy, writeScopes, ownerId? }`, the key
/// order the TypeScript build's own writes produce (a claim adds `ownerId` last). Readers must not depend on
/// key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTaskSnapshot {
    /// `task-<n>`, sequential on the board from `task-1`.
    pub id: String,
    /// 1 when created; each journaled change is exactly one more.
    pub revision: u64,
    /// Never blank.
    pub subject: String,
    /// May be empty, never absent.
    pub description: String,
    pub status: TeamTaskStatus,
    /// Task ids that must be completed first; no duplicates, no self, no cycle, all existing.
    pub blocked_by: Vec<String>,
    /// Advisory file or directory prefixes; overlaps are warnings, never a lock.
    pub write_scopes: Vec<String>,
    /// Required while in progress; absent while pending or deleted; kept when completed ("who did it").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<SessionId>,
}

/// One queued message. `content` is the content-part list exactly as sent (`[{ type: 'text', text }]` from the
/// tool); the team layer only reads its text parts and its JSON size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageSnapshot {
    /// `team-message-<uuid>`.
    pub id: String,
    /// The Lead's session id or an active member's.
    pub sender_id: SessionId,
    /// `lead` or the sender's member name.
    pub sender_name: String,
    /// The Lead or a member that is not failed (a provisioning target is valid: its mail waits).
    pub target_id: SessionId,
    /// Never empty.
    pub content: Vec<Value>,
}

/// The team's durable state, folded from the Lead session's log.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamState {
    /// The Lead's session id, which is the team's id.
    pub id: SessionId,
    /// Members in the order they were first journaled, each at its latest snapshot.
    pub members: Vec<TeamMemberSnapshot>,
    /// Tasks in creation order, each at its latest revision (deleted ones included).
    pub tasks: Vec<TeamTaskSnapshot>,
    /// Every queued message, in queue order.
    pub messages: Vec<TeamMessageSnapshot>,
    /// The ids of delivered messages, in delivery order.
    pub delivered: Vec<String>,
    /// The `n` of the next `task-<n>`.
    pub next_task_number: u64,
}

/// A task as a reader sees it: the owner by name, readiness, and advisory scope warnings.
///
/// This is what `team_task_list`, `team_task_get` and `/api/team` return, serialized in the TypeScript key
/// order: `{ id, revision, subject, description, status, ownerName?, blockedBy, writeScopes, ready,
/// writeScopeWarnings }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTaskView {
    pub id: String,
    pub revision: u64,
    pub subject: String,
    pub description: String,
    pub status: TeamTaskStatus,
    /// The owner's member name, or `lead` when the Lead owns it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    pub blocked_by: Vec<String>,
    pub write_scopes: Vec<String>,
    /// Pending, and every blocker completed. Readiness never starts anyone.
    pub ready: bool,
    /// `"<scope> is also written by <task-id>"` for each scope another live (not completed, not deleted) task
    /// also names; deduplicated, in order.
    pub write_scope_warnings: Vec<String>,
}

/// A member target resolved by name: the Lead (`lead`) or an **active** member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMember {
    pub id: SessionId,
    pub name: String,
}

/// The input of a task creation; `description` defaults to empty.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NewTask {
    pub subject: String,
    pub description: Option<String>,
    pub blocked_by: Vec<String>,
    pub write_scopes: Vec<String>,
}

/// One compare-and-set request against the board. Fields an action does not use are ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskActionRequest {
    /// Who acts: the Lead's session id or a member's.
    pub caller_id: SessionId,
    pub task_id: String,
    /// The revision the caller read; anything else is `TEAM_TASK_STALE`.
    pub revision: u64,
    pub action: TeamTaskAction,
    /// `edit`: a replacement subject (never blank).
    pub subject: Option<String>,
    /// `edit`: a replacement description.
    pub description: Option<String>,
    /// `set_dependencies`: the complete blocker list (absent means none).
    pub blocked_by: Option<Vec<String>>,
    /// `edit`: replacement write scopes.
    pub write_scopes: Option<Vec<String>>,
    /// `reassign`: the new owner (an active member or the Lead); absent unassigns.
    pub owner_id: Option<SessionId>,
}

/// One team event, the unit of the journal.
#[derive(Debug, Clone, PartialEq)]
pub enum TeamEvent {
    /// `team/member` — `{ member }`.
    Member(TeamMemberSnapshot),
    /// `team/task` — `{ task }`.
    Task(TeamTaskSnapshot),
    /// `team/message/queued` — `{ message }`.
    MessageQueued(TeamMessageSnapshot),
    /// `team/message/delivered` — `{ messageId, targetId }`: the target's own log holds the message.
    MessageDelivered {
        message_id: String,
        target_id: SessionId,
    },
}

impl TeamEvent {
    pub const MEMBER: &'static str = "team/member";
    pub const TASK: &'static str = "team/task";
    pub const MESSAGE_QUEUED: &'static str = "team/message/queued";
    pub const MESSAGE_DELIVERED: &'static str = "team/message/delivered";

    /// The log event type of this event.
    pub fn event_type(&self) -> &'static str {
        match self {
            Self::Member(_) => Self::MEMBER,
            Self::Task(_) => Self::TASK,
            Self::MessageQueued(_) => Self::MESSAGE_QUEUED,
            Self::MessageDelivered { .. } => Self::MESSAGE_DELIVERED,
        }
    }

    /// The record the service appends to the Lead's log, before the store adds `seq` and `at`:
    /// `{ type, <payload>, version, teamId }`, the key order of the TypeScript build's `journal`.
    pub fn to_record(&self, team_id: &str) -> Value {
        let mut record = Map::new();
        record.insert("type".into(), Value::from(self.event_type()));
        match self {
            Self::Member(member) => {
                record.insert("member".into(), to_json(member));
            }
            Self::Task(task) => {
                record.insert("task".into(), to_json(task));
            }
            Self::MessageQueued(message) => {
                record.insert("message".into(), to_json(message));
            }
            Self::MessageDelivered {
                message_id,
                target_id,
            } => {
                record.insert("messageId".into(), Value::from(message_id.as_str()));
                record.insert("targetId".into(), Value::from(target_id.as_str()));
            }
        }
        record.insert("version".into(), Value::from(TEAM_EVENT_VERSION));
        record.insert("teamId".into(), Value::from(team_id));
        Value::Object(record)
    }

    /// Decode one log event of the Lead's session.
    ///
    /// `Ok(None)` when it is not a team event (its `type` does not start with `team/`). A team event is checked
    /// in the TypeScript order: the record version (`TEAM_VERSION_UNSUPPORTED`), the `teamId` against `lead`
    /// (`TEAM_FOREIGN`), the type (`TEAM_INVALID_EVENT`), then the payload's shape, refused with the code the
    /// state layer would use for it (`TEAM_MEMBER_INVALID`, `TEAM_TASK_INVALID`, `TEAM_MESSAGE_INVALID`).
    pub fn from_record(event: &Value, lead: &str) -> TeamResult<Option<TeamEvent>> {
        if !is_team_event(event) {
            return Ok(None);
        }
        if event.get("version").and_then(Value::as_f64) != Some(TEAM_EVENT_VERSION as f64) {
            return Err(TeamError::new(
                TeamErrorCode::VersionUnsupported,
                format!(
                    "team event version {} is not {TEAM_EVENT_VERSION}",
                    described(event.get("version"))
                ),
            ));
        }
        if event.get("teamId").and_then(Value::as_str) != Some(lead) {
            return Err(TeamError::new(
                TeamErrorCode::Foreign,
                format!(
                    "team event names team '{}', not this session '{lead}'",
                    described(event.get("teamId"))
                ),
            ));
        }
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            Self::MEMBER => {
                let member = decode(
                    event.get("member"),
                    TeamErrorCode::MemberInvalid,
                    "a member",
                )?;
                Ok(Some(Self::Member(member)))
            }
            Self::TASK => {
                let task = decode(event.get("task"), TeamErrorCode::TaskInvalid, "a task")?;
                Ok(Some(Self::Task(task)))
            }
            Self::MESSAGE_QUEUED => {
                let message = decode(
                    event.get("message"),
                    TeamErrorCode::MessageInvalid,
                    "a queued message",
                )?;
                Ok(Some(Self::MessageQueued(message)))
            }
            Self::MESSAGE_DELIVERED => Ok(Some(Self::MessageDelivered {
                message_id: described(event.get("messageId")),
                target_id: described(event.get("targetId")),
            })),
            other => Err(TeamError::new(
                TeamErrorCode::InvalidEvent,
                format!("unknown team event '{other}'"),
            )),
        }
    }
}

/// Decode one payload, refusing it with the state layer's own code for that payload.
fn decode<T>(payload: Option<&Value>, code: TeamErrorCode, what: &str) -> TeamResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let payload = payload.cloned().unwrap_or(Value::Null);
    serde_json::from_value(payload)
        .map_err(|error| TeamError::new(code, format!("{what} is malformed: {error}")))
}

/// A JSON scalar as JavaScript's `String()` writes it, with `undefined` for an absent key. Messages are not the
/// contract (the code is), but a fold error should read like the TypeScript build's.
fn described(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Null) => "null".to_owned(),
        Some(other) => other.to_string(),
    }
}

fn to_json<T: Serialize>(value: &T) -> Value {
    // The snapshot types are plain data with string keys; serializing them cannot fail.
    serde_json::to_value(value).expect("a team snapshot serializes to JSON")
}

/// Whether a log event belongs to the team: its `type` starts with `team/`.
pub fn is_team_event(event: &Value) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("team/"))
}

/// Whether `name` is lower-kebab-case: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
pub fn is_kebab_name(name: &str) -> bool {
    let mut segments = name.split('-');
    let Some(first) = segments.next() else {
        return false;
    };
    let starts_with_letter = first.chars().next().is_some_and(|c| c.is_ascii_lowercase());
    let segment_ok = |segment: &str| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    starts_with_letter && segment_ok(first) && segments.all(segment_ok)
}

/// Fold the Lead session's log into the team state.
///
/// `events` is the whole log, each element one log line's JSON object; non-team events are skipped. Every
/// team event is decoded with [`TeamEvent::from_record`] and applied with [`TeamState::apply`]; the first
/// refusal is the fold's answer.
pub fn fold_team(events: &[Value], lead: &str) -> TeamResult<TeamState> {
    let mut state = TeamState::empty(lead);
    for event in events {
        if let Some(event) = TeamEvent::from_record(event, lead)? {
            state.apply(&event)?;
        }
    }
    Ok(state)
}

/// Refuse a task graph that names a missing blocker (`TEAM_TASK_INVALID`) or contains a cycle
/// (`TEAM_TASK_CYCLE`).
pub fn assert_task_graph(tasks: &[TeamTaskSnapshot]) -> TeamResult<()> {
    let by_id: HashMap<&str, &TeamTaskSnapshot> =
        tasks.iter().map(|task| (task.id.as_str(), task)).collect();
    let mut visiting: HashSet<&str> = HashSet::new();
    let mut done: HashSet<&str> = HashSet::new();
    for task in tasks {
        visit_task(task.id.as_str(), &by_id, &mut visiting, &mut done)?;
    }
    Ok(())
}

/// Depth-first walk of one task's blockers, the shape of the TypeScript `visit`.
fn visit_task<'a>(
    id: &'a str,
    by_id: &HashMap<&'a str, &'a TeamTaskSnapshot>,
    visiting: &mut HashSet<&'a str>,
    done: &mut HashSet<&'a str>,
) -> TeamResult<()> {
    if done.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id) {
        return Err(TeamError::new(
            TeamErrorCode::TaskCycle,
            format!("task '{id}' is part of a blocker cycle"),
        ));
    }
    let task = by_id.get(id).ok_or_else(|| {
        TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("task '{id}' is named as a blocker but does not exist"),
        )
    })?;
    for blocker in &task.blocked_by {
        visit_task(blocker.as_str(), by_id, visiting, done)?;
    }
    visiting.remove(id);
    done.insert(id);
    Ok(())
}

impl TeamState {
    /// The state of a team with nothing journaled yet.
    pub fn empty(lead: &str) -> Self {
        Self {
            id: lead.to_owned(),
            members: Vec::new(),
            tasks: Vec::new(),
            messages: Vec::new(),
            delivered: Vec::new(),
            next_task_number: 1,
        }
    }

    /// Apply one decoded event: the fold's step. Members are capped at [`DEFAULT_MAX_MEMBERS`], as in the
    /// TypeScript fold.
    pub fn apply(&mut self, event: &TeamEvent) -> TeamResult<()> {
        match event {
            TeamEvent::Member(member) => self.add_member(member.clone(), DEFAULT_MAX_MEMBERS),
            TeamEvent::Task(task) => self.add_task_snapshot(task.clone()),
            TeamEvent::MessageQueued(message) => self.queue_message(message.clone()),
            TeamEvent::MessageDelivered {
                message_id,
                target_id,
            } => self.mark_delivered(message_id, target_id),
        }
    }

    /// Record one member snapshot, validating the lifecycle it describes.
    ///
    /// A new member must be provisioning, uniquely named and within `max_members`; a known member may move
    /// once, from provisioning to active or failed, and never changes its name.
    pub fn add_member(&mut self, member: TeamMemberSnapshot, max_members: usize) -> TeamResult<()> {
        if member.id.is_empty() || member.id == self.id {
            return Err(TeamError::new(
                TeamErrorCode::MemberInvalid,
                "a member needs its own session id, not the Lead session",
            ));
        }
        if !is_kebab_name(&member.name) {
            return Err(TeamError::new(
                TeamErrorCode::MemberInvalid,
                format!(
                    "a member name must be lower-kebab-case, saw '{}'",
                    member.name
                ),
            ));
        }
        if member.description.trim().is_empty() {
            return Err(TeamError::new(
                TeamErrorCode::MemberInvalid,
                format!("member '{}' needs a description", member.name),
            ));
        }
        let phase_and_error_disagree = match member.phase {
            TeamMemberPhase::Failed => member.error.as_deref().is_none_or(str::is_empty),
            _ => member.error.is_some(),
        };
        if phase_and_error_disagree {
            return Err(TeamError::new(
                TeamErrorCode::MemberInvalid,
                format!(
                    "member '{}' has a phase and error that disagree",
                    member.name
                ),
            ));
        }

        match self.members.iter().find(|one| one.id == member.id) {
            Some(existing) => {
                if existing.name != member.name {
                    return Err(TeamError::new(
                        TeamErrorCode::MemberInvalid,
                        format!(
                            "member session {} was '{}' and became '{}'",
                            member.id, existing.name, member.name
                        ),
                    ));
                }
                if existing.phase != TeamMemberPhase::Provisioning {
                    return Err(TeamError::new(
                        TeamErrorCode::MemberPhase,
                        format!(
                            "member '{}' is already {:?} and cannot change again",
                            member.name, existing.phase
                        ),
                    ));
                }
                if member.phase == TeamMemberPhase::Provisioning {
                    return Err(TeamError::new(
                        TeamErrorCode::MemberPhase,
                        format!("member '{}' is already provisioning", member.name),
                    ));
                }
                let slot = self
                    .members
                    .iter_mut()
                    .find(|one| one.id == member.id)
                    .expect("the member was found above");
                *slot = member;
                Ok(())
            }
            None => {
                if member.phase != TeamMemberPhase::Provisioning {
                    return Err(TeamError::new(
                        TeamErrorCode::MemberPhase,
                        format!("member '{}' must start provisioning", member.name),
                    ));
                }
                if self.members.iter().any(|one| one.name == member.name) {
                    return Err(TeamError::new(
                        TeamErrorCode::MemberDuplicate,
                        format!("a member named '{}' already exists", member.name),
                    ));
                }
                if self.members.len() >= max_members {
                    return Err(TeamError::new(
                        TeamErrorCode::Limit,
                        format!(
                            "the team already has {} members; maxMembers is {max_members}",
                            self.members.len()
                        ),
                    ));
                }
                self.members.push(member);
                Ok(())
            }
        }
    }

    /// Record one queued message, validating id uniqueness, sender (the Lead or an active member), target (the
    /// Lead or a member that is not failed), content and sender name.
    pub fn queue_message(&mut self, message: TeamMessageSnapshot) -> TeamResult<()> {
        if message.id.is_empty() {
            return Err(TeamError::new(
                TeamErrorCode::MessageInvalid,
                "a queued message needs an id",
            ));
        }
        if self.messages.iter().any(|one| one.id == message.id) {
            return Err(TeamError::new(
                TeamErrorCode::MessageInvalid,
                format!("message '{}' was queued twice", message.id),
            ));
        }
        if message.sender_id != self.id {
            let sender = self.member_by_id(&message.sender_id);
            if sender.is_none_or(|one| one.phase != TeamMemberPhase::Active) {
                return Err(TeamError::new(
                    TeamErrorCode::MessageInvalid,
                    format!("message '{}' has an unknown or inactive sender", message.id),
                ));
            }
        }
        // The target may still be provisioning: mail to it waits in the durable queue and is delivered once
        // recovery (or the spawn's own activation) settles the member. A failed target is refused, because
        // nothing will ever take that mail.
        if message.target_id != self.id {
            let target = self.member_by_id(&message.target_id);
            if target.is_none_or(|one| one.phase == TeamMemberPhase::Failed) {
                return Err(TeamError::new(
                    TeamErrorCode::MessageInvalid,
                    format!("message '{}' has an unknown or failed target", message.id),
                ));
            }
        }
        if message.content.is_empty() {
            return Err(TeamError::new(
                TeamErrorCode::MessageInvalid,
                format!("message '{}' has no content", message.id),
            ));
        }
        if !is_kebab_name(&message.sender_name) {
            return Err(TeamError::new(
                TeamErrorCode::MessageInvalid,
                format!(
                    "message '{}' needs a lower-kebab-case sender name",
                    message.id
                ),
            ));
        }
        self.messages.push(message);
        Ok(())
    }

    /// Record that the target's own log accepted a queued message. A repeat is `TEAM_MESSAGE_DELIVERED`.
    pub fn mark_delivered(&mut self, message_id: &str, target_id: &str) -> TeamResult<()> {
        let message = self
            .messages
            .iter()
            .find(|one| one.id == message_id)
            .ok_or_else(|| {
                TeamError::new(
                    TeamErrorCode::MessageUnknown,
                    format!("delivery of unknown message '{message_id}'"),
                )
            })?;
        if message.target_id != target_id {
            return Err(TeamError::new(
                TeamErrorCode::MessageInvalid,
                format!(
                    "message '{message_id}' targets {}, not {target_id}",
                    message.target_id
                ),
            ));
        }
        if self.delivered.iter().any(|id| id == message_id) {
            return Err(TeamError::new(
                TeamErrorCode::MessageDelivered,
                format!("message '{message_id}' was delivered twice"),
            ));
        }
        self.delivered.push(message_id.to_owned());
        Ok(())
    }

    /// Record one complete task snapshot, checking its shape, revision continuity and the graph it makes.
    pub fn add_task_snapshot(&mut self, task: TeamTaskSnapshot) -> TeamResult<()> {
        assert_task_snapshot(&task)?;
        match self.tasks.iter().find(|one| one.id == task.id) {
            None => {
                let expected = format!("task-{}", self.next_task_number);
                if task.id != expected {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskInvalid,
                        format!("new task '{}' must be '{expected}'", task.id),
                    ));
                }
                if task.revision != 1 {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskRevision,
                        format!("new task '{}' must be revision 1", task.id),
                    ));
                }
            }
            Some(existing) => {
                if task.revision != existing.revision + 1 {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskRevision,
                        format!(
                            "task '{}' revision {} does not follow {}",
                            task.id, task.revision, existing.revision
                        ),
                    ));
                }
            }
        }
        let mut next = self.tasks.clone();
        match next.iter_mut().find(|one| one.id == task.id) {
            Some(slot) => *slot = task.clone(),
            None => next.push(task.clone()),
        }
        assert_task_graph(&next)?;
        let number = task
            .id
            .strip_prefix("task-")
            .and_then(|digits| digits.parse::<u64>().ok())
            .filter(|number| *number >= 1)
            .unwrap_or(0)
            + 1;
        self.next_task_number = self.next_task_number.max(number);
        self.tasks = next;
        Ok(())
    }

    /// Create a pending, unowned task with the next `task-<n>` id at revision 1; at most `max_tasks` tasks that
    /// are not deleted. Returns the snapshot to journal.
    pub fn create_task(
        &mut self,
        input: NewTask,
        max_tasks: usize,
    ) -> TeamResult<TeamTaskSnapshot> {
        let live = self
            .tasks
            .iter()
            .filter(|task| task.status != TeamTaskStatus::Deleted)
            .count();
        if live >= max_tasks {
            return Err(TeamError::new(
                TeamErrorCode::Limit,
                format!("the board already has {live} live tasks; maxTasks is {max_tasks}"),
            ));
        }
        let task = TeamTaskSnapshot {
            id: format!("task-{}", self.next_task_number),
            revision: 1,
            subject: input.subject,
            description: input.description.unwrap_or_default(),
            status: TeamTaskStatus::Pending,
            blocked_by: input.blocked_by,
            write_scopes: input.write_scopes,
            owner_id: None,
        };
        self.add_task_snapshot(task.clone())?;
        Ok(task)
    }

    /// A task is ready when it is pending and every blocker is completed. Readiness never starts anyone.
    pub fn is_ready(&self, task: &TeamTaskSnapshot) -> bool {
        task.status == TeamTaskStatus::Pending
            && task.blocked_by.iter().all(|id| {
                self.tasks
                    .iter()
                    .find(|one| &one.id == id)
                    .is_some_and(|one| one.status == TeamTaskStatus::Completed)
            })
    }

    /// Apply one compare-and-set action and return the task's new snapshot, to journal.
    ///
    /// The Lead may act on any task; a member on its own and on unowned work, never on another member's
    /// claim. `complete` is the owner's or the Lead's; `reassign` is the Lead's alone.
    pub fn apply_task_action(
        &mut self,
        request: &TaskActionRequest,
    ) -> TeamResult<TeamTaskSnapshot> {
        let task = self
            .tasks
            .iter()
            .find(|one| one.id == request.task_id)
            .cloned()
            .ok_or_else(|| {
                TeamError::new(
                    TeamErrorCode::TaskMissing,
                    format!("no task '{}'", request.task_id),
                )
            })?;
        if task.revision != request.revision {
            return Err(TeamError::new(
                TeamErrorCode::TaskStale,
                format!(
                    "task '{}' is at revision {}, not {}",
                    task.id, task.revision, request.revision
                ),
            ));
        }
        let is_lead = request.caller_id == self.id;
        let owns = task.owner_id.as_deref() == Some(request.caller_id.as_str());
        // A claimed or finished task is its owner's (or the Lead's). Unowned work — a pending task, or a task
        // whose owner was cleared by release/delete — is the board's, so any member may act on it.
        if !is_lead
            && !owns
            && task.owner_id.is_some()
            && task.status != TeamTaskStatus::Pending
            && task.status != TeamTaskStatus::Deleted
        {
            return Err(TeamError::new(
                TeamErrorCode::TaskStatus,
                format!("task '{}' belongs to another member", task.id),
            ));
        }
        let mut next = task.clone();
        next.revision = task.revision + 1;
        match request.action {
            TeamTaskAction::Claim => {
                if task.status != TeamTaskStatus::Pending {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!("task '{}' is {:?}, not pending", task.id, task.status),
                    ));
                }
                if !self.is_ready(&task) {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskBlocked,
                        format!(
                            "task '{}' is blocked by {}",
                            task.id,
                            task.blocked_by.join(", ")
                        ),
                    ));
                }
                next.status = TeamTaskStatus::InProgress;
                next.owner_id = Some(request.caller_id.clone());
            }
            TeamTaskAction::Release => {
                if task.status != TeamTaskStatus::InProgress {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!("task '{}' is {:?}, not in progress", task.id, task.status),
                    ));
                }
                next.status = TeamTaskStatus::Pending;
                next.owner_id = None;
            }
            TeamTaskAction::Edit => {
                if task.status == TeamTaskStatus::Deleted {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!("task '{}' is deleted", task.id),
                    ));
                }
                if let Some(subject) = &request.subject {
                    if subject.trim().is_empty() {
                        return Err(TeamError::new(
                            TeamErrorCode::TaskInvalid,
                            "an edited task needs a subject",
                        ));
                    }
                    next.subject = subject.clone();
                }
                if let Some(description) = &request.description {
                    next.description = description.clone();
                }
                if let Some(scopes) = &request.write_scopes {
                    next.write_scopes = scopes.clone();
                }
            }
            TeamTaskAction::SetDependencies => {
                if task.status == TeamTaskStatus::Deleted {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!("task '{}' is deleted", task.id),
                    ));
                }
                next.blocked_by = request.blocked_by.clone().unwrap_or_default();
            }
            TeamTaskAction::Complete => {
                if task.status != TeamTaskStatus::InProgress {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!("task '{}' is {:?}, not in progress", task.id, task.status),
                    ));
                }
                if !is_lead && !owns {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!("task '{}' is not yours to complete", task.id),
                    ));
                }
                next.status = TeamTaskStatus::Completed;
            }
            TeamTaskAction::Reopen => {
                if task.status != TeamTaskStatus::Completed
                    && task.status != TeamTaskStatus::Deleted
                {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!(
                            "task '{}' is {:?}, not completed or deleted",
                            task.id, task.status
                        ),
                    ));
                }
                next.status = TeamTaskStatus::Pending;
                next.owner_id = None;
            }
            TeamTaskAction::Reassign => {
                if !is_lead {
                    return Err(TeamError::new(
                        TeamErrorCode::LeadRequired,
                        "only the Lead can reassign a task",
                    ));
                }
                match &request.owner_id {
                    // The Lead may own work itself; the task is rendered as owned by `lead`.
                    Some(owner) if *owner == self.id => {
                        next.status = TeamTaskStatus::InProgress;
                        next.owner_id = Some(owner.clone());
                    }
                    Some(owner) => {
                        let member = self.member_by_id(owner);
                        if member.is_none_or(|one| one.phase != TeamMemberPhase::Active) {
                            return Err(TeamError::new(
                                TeamErrorCode::MemberInvalid,
                                format!("no active member {owner}"),
                            ));
                        }
                        next.status = TeamTaskStatus::InProgress;
                        next.owner_id = Some(owner.clone());
                    }
                    None => {
                        next.status = TeamTaskStatus::Pending;
                        next.owner_id = None;
                    }
                }
            }
            TeamTaskAction::Delete => {
                // Unowned pending work is the board's, not one member's; a claimed task is its owner's or the
                // Lead's.
                if !is_lead && task.owner_id.is_some() && !owns {
                    return Err(TeamError::new(
                        TeamErrorCode::TaskStatus,
                        format!("task '{}' is not yours to delete", task.id),
                    ));
                }
                next.status = TeamTaskStatus::Deleted;
                next.owner_id = None;
            }
        }
        self.add_task_snapshot(next)?;
        self.tasks
            .iter()
            .find(|one| one.id == request.task_id)
            .cloned()
            .ok_or_else(|| {
                TeamError::new(
                    TeamErrorCode::InvalidEvent,
                    format!("task '{}' vanished after a journal write", request.task_id),
                )
            })
    }

    /// The task as a reader sees it, with readiness and advisory write-scope overlaps.
    pub fn task_view(&self, task: &TeamTaskSnapshot) -> TeamTaskView {
        let owner_name = match &task.owner_id {
            None => None,
            Some(owner) if owner == &self.id => Some(LEAD_NAME.to_owned()),
            Some(owner) => self.member_by_id(owner).map(|member| member.name.clone()),
        };
        let mut warnings = Vec::new();
        let mut seen = HashSet::new();
        for scope in &task.write_scopes {
            for other in &self.tasks {
                if other.id == task.id
                    || other.status == TeamTaskStatus::Deleted
                    || other.status == TeamTaskStatus::Completed
                    || !other.write_scopes.contains(scope)
                {
                    continue;
                }
                let warning = format!("{scope} is also written by {}", other.id);
                if seen.insert(warning.clone()) {
                    warnings.push(warning);
                }
            }
        }
        TeamTaskView {
            id: task.id.clone(),
            revision: task.revision,
            subject: task.subject.clone(),
            description: task.description.clone(),
            status: task.status,
            owner_name,
            blocked_by: task.blocked_by.clone(),
            write_scopes: task.write_scopes.clone(),
            ready: self.is_ready(task),
            write_scope_warnings: warnings,
        }
    }

    /// The member whose session id this is.
    pub fn member_by_id(&self, id: &str) -> Option<&TeamMemberSnapshot> {
        self.members.iter().find(|member| member.id == id)
    }

    /// The member with this name, in any phase.
    pub fn member_by_name(&self, name: &str) -> Option<&TeamMemberSnapshot> {
        self.members.iter().find(|member| member.name == name)
    }

    /// Resolve a member target by name: `lead` is the Lead; a member resolves only while active.
    pub fn resolve_member(&self, name: &str) -> Option<ResolvedMember> {
        if name == LEAD_NAME {
            return Some(ResolvedMember {
                id: self.id.clone(),
                name: LEAD_NAME.to_owned(),
            });
        }
        self.members
            .iter()
            .find(|member| member.name == name && member.phase == TeamMemberPhase::Active)
            .map(|member| ResolvedMember {
                id: member.id.clone(),
                name: member.name.clone(),
            })
    }

    /// Members that are active or still provisioning — the set a wait can make progress on.
    pub fn active_or_provisioning(&self) -> Vec<&TeamMemberSnapshot> {
        self.members
            .iter()
            .filter(|member| {
                member.phase == TeamMemberPhase::Active
                    || member.phase == TeamMemberPhase::Provisioning
            })
            .collect()
    }

    /// Whether this message id has been delivered.
    pub fn is_delivered(&self, message_id: &str) -> bool {
        self.delivered.iter().any(|id| id == message_id)
    }

    /// Queued messages to this target that are not yet delivered.
    pub fn pending_for(&self, target_id: &str) -> usize {
        self.messages
            .iter()
            .filter(|message| message.target_id == target_id && !self.is_delivered(&message.id))
            .count()
    }
}

/// The shape checks `add_task_snapshot` makes before it considers revision continuity or the graph.
fn assert_task_snapshot(task: &TeamTaskSnapshot) -> TeamResult<()> {
    let valid_id = task.id.strip_prefix("task-").is_some_and(|digits| {
        !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit())
            && !digits.starts_with('0')
            && digits != "0"
    });
    if !valid_id {
        return Err(TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("a task needs a 'task-<n>' id, saw '{}'", task.id),
        ));
    }
    if task.subject.trim().is_empty() {
        return Err(TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("task '{}' needs a subject", task.id),
        ));
    }
    if task.revision < 1 {
        return Err(TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("task '{}' has revision {}", task.id, task.revision),
        ));
    }
    if task.status == TeamTaskStatus::InProgress
        && task.owner_id.as_deref().is_none_or(str::is_empty)
    {
        return Err(TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("task '{}' is in progress without an owner", task.id),
        ));
    }
    if (task.status == TeamTaskStatus::Pending || task.status == TeamTaskStatus::Deleted)
        && task.owner_id.is_some()
    {
        return Err(TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("task '{}' is {:?} but still owned", task.id, task.status),
        ));
    }
    let unique: HashSet<&String> = task.blocked_by.iter().collect();
    if unique.len() != task.blocked_by.len() {
        return Err(TeamError::new(
            TeamErrorCode::TaskInvalid,
            format!("task '{}' has a malformed blocker list", task.id),
        ));
    }
    if task.blocked_by.iter().any(|id| id == &task.id) {
        return Err(TeamError::new(
            TeamErrorCode::TaskCycle,
            format!("task '{}' blocks itself", task.id),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kebab_names_follow_the_typescript_pattern() {
        for good in ["alpha", "a", "alpha-2", "a1-b2-c3", "lead"] {
            assert!(is_kebab_name(good), "{good} is kebab");
        }
        for bad in [
            "", "Alpha", "1alpha", "alpha-", "-alpha", "al--pha", "al_pha", "al pha", "é",
        ] {
            assert!(!is_kebab_name(bad), "{bad:?} is not kebab");
        }
    }

    #[test]
    fn only_team_types_are_team_events() {
        assert!(is_team_event(&json!({ "type": "team/member" })));
        assert!(is_team_event(&json!({ "type": "team/anything" })));
        assert!(!is_team_event(&json!({ "type": "message" })));
        assert!(!is_team_event(&json!({ "type": "teams/member" })));
        assert!(!is_team_event(&json!({ "kind": "team/member" })));
    }

    #[test]
    fn a_record_carries_type_payload_version_and_team() {
        let member = TeamMemberSnapshot {
            id: "session-b".into(),
            name: "alpha".into(),
            description: "the teammate".into(),
            context: TeamMemberContext::Fresh,
            phase: TeamMemberPhase::Provisioning,
            error: None,
        };
        assert_eq!(
            TeamEvent::Member(member).to_record("session-a"),
            json!({
                "type": "team/member",
                "member": { "id": "session-b", "name": "alpha", "description": "the teammate", "context": "fresh", "phase": "provisioning" },
                "version": 2,
                "teamId": "session-a",
            })
        );
        assert_eq!(
            TeamEvent::MessageDelivered {
                message_id: "team-message-1".into(),
                target_id: "session-b".into()
            }
            .to_record("session-a"),
            json!({ "type": "team/message/delivered", "messageId": "team-message-1", "targetId": "session-b", "version": 2, "teamId": "session-a" })
        );
    }

    #[test]
    fn a_task_snapshot_reads_the_typescript_shape_and_omits_an_absent_owner() {
        let written = json!({ "id": "task-1", "revision": 2, "subject": "write the thing", "description": "", "status": "in_progress", "ownerId": "session-b", "blockedBy": [], "writeScopes": ["src/team"] });
        let task: TeamTaskSnapshot =
            serde_json::from_value(written).expect("the TypeScript shape decodes");
        assert_eq!(task.status, TeamTaskStatus::InProgress);
        assert_eq!(task.owner_id.as_deref(), Some("session-b"));
        let pending = TeamTaskSnapshot {
            status: TeamTaskStatus::Pending,
            owner_id: None,
            ..task
        };
        let json = serde_json::to_value(&pending).expect("a task serializes");
        assert!(
            json.get("ownerId").is_none(),
            "no ownerId key while unowned"
        );
        assert_eq!(json["status"], "pending");
        assert_eq!(json["blockedBy"], json!([]));
    }

    #[test]
    fn the_empty_state_starts_numbering_at_one() {
        let state = TeamState::empty("session-a");
        assert_eq!(state.id, "session-a");
        assert_eq!(state.next_task_number, 1);
        assert!(state.members.is_empty() && state.tasks.is_empty() && state.messages.is_empty());
    }

    // --- M1: the fold and the rules of the pure layer ---

    const LEAD: &str = "session-lead";
    const A: &str = "session-a";
    const B: &str = "session-b";

    fn record(kind: &str, field: &str, payload: Value) -> Value {
        let mut map = Map::new();
        map.insert("type".to_owned(), Value::from(kind));
        map.insert(field.to_owned(), payload);
        map.insert("version".to_owned(), Value::from(TEAM_EVENT_VERSION));
        map.insert("teamId".to_owned(), Value::from(LEAD));
        Value::Object(map)
    }

    fn member_record(member: &TeamMemberSnapshot) -> Value {
        record(
            TeamEvent::MEMBER,
            "member",
            serde_json::to_value(member).expect("a member serializes"),
        )
    }

    fn teammate(id: &str, name: &str, phase: TeamMemberPhase) -> TeamMemberSnapshot {
        TeamMemberSnapshot {
            id: id.to_owned(),
            name: name.to_owned(),
            description: "a test teammate".to_owned(),
            context: TeamMemberContext::Fresh,
            phase,
            error: None,
        }
    }

    fn failed(id: &str, name: &str, error: &str) -> TeamMemberSnapshot {
        TeamMemberSnapshot {
            id: id.to_owned(),
            name: name.to_owned(),
            description: "a test teammate".to_owned(),
            context: TeamMemberContext::Fresh,
            phase: TeamMemberPhase::Failed,
            error: Some(error.to_owned()),
        }
    }

    fn message(id: &str, sender: &str, sender_name: &str, target: &str) -> TeamMessageSnapshot {
        TeamMessageSnapshot {
            id: id.to_owned(),
            sender_id: sender.to_owned(),
            sender_name: sender_name.to_owned(),
            target_id: target.to_owned(),
            content: vec![json!({ "type": "text", "text": "go" })],
        }
    }

    fn team() -> TeamState {
        TeamState::empty(LEAD)
    }

    fn add_provisioning(state: &mut TeamState, id: &str, name: &str) {
        state
            .add_member(
                teammate(id, name, TeamMemberPhase::Provisioning),
                DEFAULT_MAX_MEMBERS,
            )
            .expect("a new member is admitted");
    }

    fn add_active(state: &mut TeamState, id: &str, name: &str) {
        add_provisioning(state, id, name);
        state
            .add_member(
                teammate(id, name, TeamMemberPhase::Active),
                DEFAULT_MAX_MEMBERS,
            )
            .expect("a provisioning member settles active");
    }

    fn create(state: &mut TeamState, subject: &str) -> TeamTaskSnapshot {
        state
            .create_task(
                NewTask {
                    subject: subject.to_owned(),
                    description: None,
                    blocked_by: Vec::new(),
                    write_scopes: Vec::new(),
                },
                DEFAULT_MAX_TASKS,
            )
            .expect("a plain task is created")
    }

    fn act(
        state: &mut TeamState,
        caller: &str,
        task_id: &str,
        revision: u64,
        action: TeamTaskAction,
    ) -> TeamResult<TeamTaskSnapshot> {
        state.apply_task_action(&TaskActionRequest {
            caller_id: caller.to_owned(),
            task_id: task_id.to_owned(),
            revision,
            action,
            subject: None,
            description: None,
            blocked_by: None,
            write_scopes: None,
            owner_id: None,
        })
    }

    fn apply(
        state: &mut TeamState,
        caller: &str,
        task_id: &str,
        revision: u64,
        action: TeamTaskAction,
    ) -> TeamTaskSnapshot {
        act(state, caller, task_id, revision, action).expect("the action applies")
    }

    fn refusal(result: TeamResult<()>) -> TeamErrorCode {
        result.expect_err("the operation is refused").code
    }

    #[test]
    fn an_empty_log_folds_empty_and_non_team_events_are_skipped() {
        let events = [
            json!({ "type": "message", "message": { "role": "user" } }),
            json!({ "seq": 1, "at": "", "type": "turn/completed" }),
        ];
        assert_eq!(fold_team(&events, LEAD).expect("the fold succeeds"), team());
    }

    #[test]
    fn a_member_starts_provisioning_and_settles_once() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        assert_eq!(state.members[0].phase, TeamMemberPhase::Active);

        // A settled member cannot change again.
        assert_eq!(
            refusal(state.add_member(failed(A, "alpha", "boom"), DEFAULT_MAX_MEMBERS)),
            TeamErrorCode::MemberPhase
        );
        // A member that never provisioned cannot appear directly active.
        assert_eq!(
            refusal(team().add_member(
                teammate(B, "beta", TeamMemberPhase::Active),
                DEFAULT_MAX_MEMBERS
            )),
            TeamErrorCode::MemberPhase
        );
        // Nor can one settle twice.
        let mut failed_state = team();
        add_provisioning(&mut failed_state, A, "alpha");
        failed_state
            .add_member(failed(A, "alpha", "boom"), DEFAULT_MAX_MEMBERS)
            .expect("provisioning settles failed");
        assert_eq!(
            refusal(failed_state.add_member(
                teammate(A, "alpha", TeamMemberPhase::Active),
                DEFAULT_MAX_MEMBERS
            )),
            TeamErrorCode::MemberPhase
        );
    }

    #[test]
    fn a_members_phase_and_error_must_agree_and_its_identity_is_checked() {
        // failed without an error.
        assert_eq!(
            refusal(team().add_member(
                teammate(A, "alpha", TeamMemberPhase::Failed),
                DEFAULT_MAX_MEMBERS
            )),
            TeamErrorCode::MemberInvalid
        );
        // active with an error.
        let mut active_with_error = teammate(A, "alpha", TeamMemberPhase::Active);
        active_with_error.error = Some("boom".to_owned());
        assert_eq!(
            refusal(team().add_member(active_with_error, DEFAULT_MAX_MEMBERS)),
            TeamErrorCode::MemberInvalid
        );
        // A member cannot be the Lead session.
        assert_eq!(
            refusal(team().add_member(
                teammate(LEAD, "alpha", TeamMemberPhase::Provisioning),
                DEFAULT_MAX_MEMBERS
            )),
            TeamErrorCode::MemberInvalid
        );
        // A name must be lower-kebab-case and a description non-blank.
        assert_eq!(
            refusal(team().add_member(
                teammate(A, "Alpha", TeamMemberPhase::Provisioning),
                DEFAULT_MAX_MEMBERS
            )),
            TeamErrorCode::MemberInvalid
        );
        let mut blank = teammate(A, "alpha", TeamMemberPhase::Provisioning);
        blank.description = "  ".to_owned();
        assert_eq!(
            refusal(team().add_member(blank, DEFAULT_MAX_MEMBERS)),
            TeamErrorCode::MemberInvalid
        );
        // A second member with a taken name is a duplicate.
        let mut state = team();
        add_active(&mut state, A, "alpha");
        assert_eq!(
            refusal(state.add_member(
                teammate(B, "alpha", TeamMemberPhase::Provisioning),
                DEFAULT_MAX_MEMBERS
            )),
            TeamErrorCode::MemberDuplicate
        );
        // A session cannot be renamed between snapshots.
        assert_eq!(
            refusal(state.add_member(
                teammate(A, "beta", TeamMemberPhase::Failed).with_error("x"),
                DEFAULT_MAX_MEMBERS
            )),
            TeamErrorCode::MemberInvalid
        );
    }

    // A tiny helper so the rename test reads as a snapshot of the same session.
    trait WithError {
        fn with_error(self, error: &str) -> Self;
    }

    impl WithError for TeamMemberSnapshot {
        fn with_error(mut self, error: &str) -> Self {
            self.error = Some(error.to_owned());
            self
        }
    }

    #[test]
    fn the_fold_refuses_a_foreign_team_a_wrong_version_and_an_unknown_delivery() {
        let mut foreign = member_record(&teammate(A, "alpha", TeamMemberPhase::Provisioning));
        foreign["teamId"] = Value::from("session-other");
        assert_eq!(
            fold_team(&[foreign.clone()], LEAD)
                .expect_err("a foreign team is refused")
                .code,
            TeamErrorCode::Foreign
        );
        let mut wrong_version = foreign;
        wrong_version["teamId"] = Value::from(LEAD);
        wrong_version["version"] = Value::from(3);
        assert_eq!(
            fold_team(&[wrong_version], LEAD)
                .expect_err("a wrong version is refused")
                .code,
            TeamErrorCode::VersionUnsupported
        );
        let delivery = record(
            TeamEvent::MESSAGE_DELIVERED,
            "messageId",
            Value::from("team-message-1"),
        );
        let mut delivery = delivery;
        delivery["targetId"] = Value::from(A);
        assert_eq!(
            fold_team(&[delivery], LEAD)
                .expect_err("an unknown delivery is refused")
                .code,
            TeamErrorCode::MessageUnknown
        );
        let unknown = record("team/mystery", "payload", Value::Null);
        assert_eq!(
            fold_team(&[unknown], LEAD)
                .expect_err("an unknown team event is refused")
                .code,
            TeamErrorCode::InvalidEvent
        );
    }

    #[test]
    fn the_fold_replays_a_member_a_task_a_queued_message_and_its_delivery() {
        let mut expected = team();
        add_provisioning(&mut expected, A, "alpha");
        expected
            .add_member(
                teammate(A, "alpha", TeamMemberPhase::Active),
                DEFAULT_MAX_MEMBERS,
            )
            .unwrap();
        let task = create(&mut expected, "do the thing");
        let sent = message("team-message-1", LEAD, "lead", A);
        expected.queue_message(sent.clone()).unwrap();
        expected.mark_delivered(&sent.id, A).unwrap();

        let events = vec![
            member_record(&teammate(A, "alpha", TeamMemberPhase::Provisioning)),
            member_record(&teammate(A, "alpha", TeamMemberPhase::Active)),
            record(
                TeamEvent::TASK,
                "task",
                serde_json::to_value(&task).unwrap(),
            ),
            record(
                TeamEvent::MESSAGE_QUEUED,
                "message",
                serde_json::to_value(&sent).unwrap(),
            ),
            {
                let mut delivered = record(
                    TeamEvent::MESSAGE_DELIVERED,
                    "messageId",
                    Value::from(sent.id.as_str()),
                );
                delivered["targetId"] = Value::from(A);
                delivered
            },
        ];
        let folded = fold_team(&events, LEAD).expect("the log replays");
        assert_eq!(folded, expected);
        assert_eq!(folded.delivered, vec![sent.id]);
    }

    #[test]
    fn the_board_is_compare_and_set() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        let first = create(&mut state, "one");
        let second = state
            .create_task(
                NewTask {
                    subject: "two".to_owned(),
                    description: None,
                    blocked_by: vec![first.id.clone()],
                    write_scopes: Vec::new(),
                },
                DEFAULT_MAX_TASKS,
            )
            .unwrap();
        assert_eq!(second.id, "task-2");
        assert!(!state.is_ready(&second), "a blocked task is not ready");
        assert!(state.is_ready(&first));

        assert_eq!(
            refusal(act(&mut state, A, &second.id, 1, TeamTaskAction::Claim).map(|_| ())),
            TeamErrorCode::TaskBlocked
        );
        let claimed = apply(&mut state, A, &first.id, 1, TeamTaskAction::Claim);
        assert_eq!(claimed.status, TeamTaskStatus::InProgress);
        assert_eq!(claimed.owner_id.as_deref(), Some(A));
        assert_eq!(claimed.revision, 2);

        assert_eq!(
            refusal(act(&mut state, A, &first.id, 1, TeamTaskAction::Complete).map(|_| ())),
            TeamErrorCode::TaskStale
        );
        assert_eq!(
            refusal(act(&mut state, A, &second.id, 1, TeamTaskAction::Complete).map(|_| ())),
            TeamErrorCode::TaskStatus
        );
        let completed = apply(&mut state, A, &first.id, 2, TeamTaskAction::Complete);
        assert_eq!(completed.status, TeamTaskStatus::Completed);
        assert!(
            state.is_ready(&second),
            "completing the blocker made the dependent ready"
        );
    }

    #[test]
    fn a_teammate_cannot_touch_another_members_claim_and_only_the_lead_reassigns() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        add_active(&mut state, B, "beta");
        let task = create(&mut state, "shared");
        apply(&mut state, A, &task.id, 1, TeamTaskAction::Claim);

        assert_eq!(
            refusal(act(&mut state, B, &task.id, 2, TeamTaskAction::Complete).map(|_| ())),
            TeamErrorCode::TaskStatus
        );
        assert_eq!(
            refusal(
                state
                    .apply_task_action(&TaskActionRequest {
                        caller_id: A.to_owned(),
                        task_id: task.id.clone(),
                        revision: 2,
                        action: TeamTaskAction::Reassign,
                        subject: None,
                        description: None,
                        blocked_by: None,
                        write_scopes: None,
                        owner_id: Some(B.to_owned()),
                    })
                    .map(|_| ())
            ),
            TeamErrorCode::LeadRequired
        );
        let reassigned = state
            .apply_task_action(&TaskActionRequest {
                caller_id: LEAD.to_owned(),
                task_id: task.id.clone(),
                revision: 2,
                action: TeamTaskAction::Reassign,
                subject: None,
                description: None,
                blocked_by: None,
                write_scopes: None,
                owner_id: Some(B.to_owned()),
            })
            .expect("the Lead reassigns");
        assert_eq!(reassigned.owner_id.as_deref(), Some(B));
        assert_eq!(reassigned.status, TeamTaskStatus::InProgress);
    }

    #[test]
    fn the_lead_may_own_a_task_and_an_absent_owner_unassigns_it() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        let task = create(&mut state, "lead work");
        let reassigned = state
            .apply_task_action(&TaskActionRequest {
                caller_id: LEAD.to_owned(),
                task_id: task.id.clone(),
                revision: 1,
                action: TeamTaskAction::Reassign,
                subject: None,
                description: None,
                blocked_by: None,
                write_scopes: None,
                owner_id: Some(LEAD.to_owned()),
            })
            .expect("the Lead may own work itself");
        assert_eq!(reassigned.owner_id.as_deref(), Some(LEAD));
        assert_eq!(
            state.task_view(&reassigned).owner_name.as_deref(),
            Some("lead")
        );

        let unassigned = state
            .apply_task_action(&TaskActionRequest {
                caller_id: LEAD.to_owned(),
                task_id: task.id,
                revision: 2,
                action: TeamTaskAction::Reassign,
                subject: None,
                description: None,
                blocked_by: None,
                write_scopes: None,
                owner_id: None,
            })
            .expect("an absent owner unassigns");
        assert_eq!(unassigned.status, TeamTaskStatus::Pending);
        assert_eq!(unassigned.owner_id, None);
    }

    #[test]
    fn task_statuses_move_through_release_reopen_and_delete_and_ownership_follows() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        let task = create(&mut state, "lifecycle");
        apply(&mut state, A, &task.id, 1, TeamTaskAction::Claim);
        let released = apply(&mut state, A, &task.id, 2, TeamTaskAction::Release);
        assert_eq!(released.status, TeamTaskStatus::Pending);
        assert_eq!(released.owner_id, None);

        // A pending task has nothing to reopen.
        assert_eq!(
            refusal(act(&mut state, A, &task.id, 3, TeamTaskAction::Reopen).map(|_| ())),
            TeamErrorCode::TaskStatus
        );
        let deleted = apply(&mut state, A, &task.id, 3, TeamTaskAction::Delete);
        assert_eq!(deleted.status, TeamTaskStatus::Deleted);
        assert_eq!(deleted.owner_id, None);
        let reopened = apply(&mut state, A, &task.id, 4, TeamTaskAction::Reopen);
        assert_eq!(reopened.status, TeamTaskStatus::Pending);
        apply(&mut state, A, &task.id, 5, TeamTaskAction::Claim);
        let completed = apply(&mut state, A, &task.id, 6, TeamTaskAction::Complete);
        assert_eq!(completed.status, TeamTaskStatus::Completed);
        assert_eq!(
            completed.owner_id.as_deref(),
            Some(A),
            "a completed task keeps who did it"
        );
    }

    #[test]
    fn blocker_cycles_and_missing_blockers_are_refused() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        let one = create(&mut state, "one");
        let two = state
            .create_task(
                NewTask {
                    subject: "two".to_owned(),
                    description: None,
                    blocked_by: vec![one.id.clone()],
                    write_scopes: Vec::new(),
                },
                DEFAULT_MAX_TASKS,
            )
            .unwrap();
        assert_eq!(
            refusal(
                state
                    .create_task(
                        NewTask {
                            subject: "three".to_owned(),
                            description: None,
                            blocked_by: vec!["task-404".to_owned()],
                            write_scopes: Vec::new(),
                        },
                        DEFAULT_MAX_TASKS,
                    )
                    .map(|_| ())
            ),
            TeamErrorCode::TaskInvalid
        );
        assert_eq!(
            refusal(
                state
                    .apply_task_action(&TaskActionRequest {
                        caller_id: LEAD.to_owned(),
                        task_id: one.id.clone(),
                        revision: 1,
                        action: TeamTaskAction::SetDependencies,
                        subject: None,
                        description: None,
                        blocked_by: Some(vec![two.id.clone()]),
                        write_scopes: None,
                        owner_id: None,
                    })
                    .map(|_| ())
            ),
            TeamErrorCode::TaskCycle
        );
        // A snapshot that names itself as a blocker is a cycle at the shape check.
        let mut itself = two.clone();
        itself.id = "task-3".to_owned();
        itself.revision = 1;
        itself.blocked_by = vec!["task-3".to_owned()];
        assert_eq!(
            refusal(state.add_task_snapshot(itself)),
            TeamErrorCode::TaskCycle
        );
    }

    #[test]
    fn the_view_names_the_owner_reports_readiness_and_warns_about_shared_write_scopes() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        let one = state
            .create_task(
                NewTask {
                    subject: "one".to_owned(),
                    description: None,
                    blocked_by: Vec::new(),
                    write_scopes: vec!["src/team".to_owned()],
                },
                DEFAULT_MAX_TASKS,
            )
            .unwrap();
        state
            .create_task(
                NewTask {
                    subject: "two".to_owned(),
                    description: None,
                    blocked_by: Vec::new(),
                    write_scopes: vec!["src/team".to_owned()],
                },
                DEFAULT_MAX_TASKS,
            )
            .unwrap();
        apply(&mut state, A, &one.id, 1, TeamTaskAction::Claim);
        let view = state.task_view(&state.tasks[0].clone());
        assert_eq!(view.owner_name.as_deref(), Some("alpha"));
        assert!(!view.ready);
        let warnings = state
            .task_view(&state.tasks[1].clone())
            .write_scope_warnings;
        assert_eq!(
            warnings,
            vec!["src/team is also written by task-1".to_owned()]
        );
        // A completed task no longer warns about its scopes.
        let two = state.tasks[1].id.clone();
        apply(&mut state, A, &two, 1, TeamTaskAction::Claim);
        apply(&mut state, A, &two, 2, TeamTaskAction::Complete);
        assert!(
            state
                .task_view(&state.tasks[0].clone())
                .write_scope_warnings
                .is_empty()
        );
    }

    #[test]
    fn resolution_addresses_the_lead_and_refuses_a_provisioning_member() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        assert_eq!(
            state.resolve_member("lead"),
            Some(ResolvedMember {
                id: LEAD.to_owned(),
                name: "lead".to_owned()
            })
        );
        assert_eq!(state.resolve_member("alpha").unwrap().id, A);
        assert_eq!(state.resolve_member("nobody"), None);
        add_provisioning(&mut state, B, "beta");
        assert_eq!(
            state.resolve_member("beta"),
            None,
            "a provisioning member is not addressable yet"
        );
        assert_eq!(state.active_or_provisioning().len(), 2);
    }

    #[test]
    fn the_member_and_task_caps_are_refusals_with_their_own_code() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        assert_eq!(
            refusal(state.add_member(teammate(B, "beta", TeamMemberPhase::Provisioning), 1)),
            TeamErrorCode::Limit
        );
        assert_eq!(
            refusal(
                state
                    .create_task(
                        NewTask {
                            subject: "x".to_owned(),
                            ..NewTask::default()
                        },
                        0
                    )
                    .map(|_| ())
            ),
            TeamErrorCode::Limit
        );
    }

    #[test]
    fn a_task_snapshot_must_be_well_formed_and_take_the_next_id_at_revision_one() {
        let mut state = team();
        let good = TeamTaskSnapshot {
            id: "task-1".to_owned(),
            revision: 2,
            subject: "one".to_owned(),
            description: String::new(),
            status: TeamTaskStatus::Pending,
            blocked_by: Vec::new(),
            write_scopes: Vec::new(),
            owner_id: None,
        };
        // A new task must take task-1 at revision 1.
        assert_eq!(
            refusal(state.add_task_snapshot(good.clone())),
            TeamErrorCode::TaskRevision
        );
        let mut first = good.clone();
        first.revision = 1;
        state.add_task_snapshot(first.clone()).unwrap();
        // A task id must be task-<n>.
        let mut bad_id = first.clone();
        bad_id.id = "task-0".to_owned();
        assert_eq!(
            refusal(state.add_task_snapshot(bad_id)),
            TeamErrorCode::TaskInvalid
        );
        // A subject may not be blank.
        let mut blank = first.clone();
        blank.id = "task-2".to_owned();
        blank.subject = "  ".to_owned();
        assert_eq!(
            refusal(state.add_task_snapshot(blank)),
            TeamErrorCode::TaskInvalid
        );
        // In progress needs an owner; pending must not have one.
        let mut unowned = first.clone();
        unowned.id = "task-2".to_owned();
        unowned.status = TeamTaskStatus::InProgress;
        assert_eq!(
            refusal(state.add_task_snapshot(unowned)),
            TeamErrorCode::TaskInvalid
        );
        let mut owned = first.clone();
        owned.id = "task-2".to_owned();
        owned.owner_id = Some(A.to_owned());
        assert_eq!(
            refusal(state.add_task_snapshot(owned)),
            TeamErrorCode::TaskInvalid
        );
        // No duplicate blockers.
        let mut duplicated = first.clone();
        duplicated.id = "task-2".to_owned();
        duplicated.blocked_by = vec!["task-1".to_owned(), "task-1".to_owned()];
        assert_eq!(
            refusal(state.add_task_snapshot(duplicated)),
            TeamErrorCode::TaskInvalid
        );
    }

    #[test]
    fn a_queued_message_validates_its_id_sender_target_content_and_sender_name() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        add_provisioning(&mut state, B, "beta");
        let good = message("team-message-1", LEAD, "lead", A);
        state.queue_message(good.clone()).unwrap();
        // A repeated id is refused.
        assert_eq!(
            refusal(state.queue_message(good.clone())),
            TeamErrorCode::MessageInvalid
        );
        // An unknown or inactive sender is refused.
        assert_eq!(
            refusal(state.queue_message(message("team-message-2", B, "beta", A))),
            TeamErrorCode::MessageInvalid
        );
        // A failed target is refused; a provisioning target is valid.
        state
            .add_member(failed(B, "beta", "boom"), DEFAULT_MAX_MEMBERS)
            .unwrap();
        assert_eq!(
            refusal(state.queue_message(message("team-message-3", LEAD, "lead", B))),
            TeamErrorCode::MessageInvalid
        );
        // No content is refused.
        let mut empty = message("team-message-4", LEAD, "lead", A);
        empty.content.clear();
        assert_eq!(
            refusal(state.queue_message(empty)),
            TeamErrorCode::MessageInvalid
        );
        // A non-kebab sender name is refused.
        assert_eq!(
            refusal(state.queue_message(message("team-message-5", LEAD, "Lead", A))),
            TeamErrorCode::MessageInvalid
        );
    }

    #[test]
    fn the_delivery_ledger_refuses_an_unknown_message_a_wrong_target_and_a_repeat() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        let sent = message("team-message-1", LEAD, "lead", A);
        assert_eq!(
            refusal(state.mark_delivered("team-message-1", A)),
            TeamErrorCode::MessageUnknown
        );
        state.queue_message(sent.clone()).unwrap();
        assert_eq!(
            refusal(state.mark_delivered(&sent.id, B)),
            TeamErrorCode::MessageInvalid
        );
        state.mark_delivered(&sent.id, A).unwrap();
        assert_eq!(
            refusal(state.mark_delivered(&sent.id, A)),
            TeamErrorCode::MessageDelivered
        );
        assert_eq!(state.pending_for(A), 0);
        state
            .queue_message(message("team-message-2", LEAD, "lead", A))
            .unwrap();
        assert_eq!(state.pending_for(A), 1);
    }

    #[test]
    fn edit_replaces_fields_and_refuses_a_blank_subject() {
        let mut state = team();
        add_active(&mut state, A, "alpha");
        let task = create(&mut state, "original");
        let edited = state
            .apply_task_action(&TaskActionRequest {
                caller_id: A.to_owned(),
                task_id: task.id.clone(),
                revision: 1,
                action: TeamTaskAction::Edit,
                subject: Some("renamed".to_owned()),
                description: Some("details".to_owned()),
                blocked_by: None,
                write_scopes: Some(vec!["src".to_owned()]),
                owner_id: None,
            })
            .expect("an edit applies");
        assert_eq!(edited.subject, "renamed");
        assert_eq!(edited.description, "details");
        assert_eq!(edited.write_scopes, vec!["src".to_owned()]);
        assert_eq!(
            refusal(
                state
                    .apply_task_action(&TaskActionRequest {
                        caller_id: A.to_owned(),
                        task_id: task.id.clone(),
                        revision: 2,
                        action: TeamTaskAction::Edit,
                        subject: Some("  ".to_owned()),
                        description: None,
                        blocked_by: None,
                        write_scopes: None,
                        owner_id: None,
                    })
                    .map(|_| ())
            ),
            TeamErrorCode::TaskInvalid
        );
        let deleted = apply(&mut state, A, &task.id, 2, TeamTaskAction::Delete);
        assert_eq!(deleted.status, TeamTaskStatus::Deleted);
        assert_eq!(
            refusal(
                state
                    .apply_task_action(&TaskActionRequest {
                        caller_id: A.to_owned(),
                        task_id: task.id,
                        revision: 3,
                        action: TeamTaskAction::Edit,
                        subject: Some("again".to_owned()),
                        description: None,
                        blocked_by: None,
                        write_scopes: None,
                        owner_id: None,
                    })
                    .map(|_| ())
            ),
            TeamErrorCode::TaskStatus
        );
    }

    #[test]
    fn the_next_task_number_follows_every_journaled_id() {
        let mut state = team();
        create(&mut state, "one");
        assert_eq!(state.next_task_number, 2);
        let mut ahead = TeamTaskSnapshot {
            id: "task-5".to_owned(),
            revision: 1,
            subject: "five".to_owned(),
            description: String::new(),
            status: TeamTaskStatus::Pending,
            blocked_by: Vec::new(),
            write_scopes: Vec::new(),
            owner_id: None,
        };
        // task-5 does not follow nextTaskNumber 2.
        assert_eq!(
            refusal(state.add_task_snapshot(ahead.clone())),
            TeamErrorCode::TaskInvalid
        );
        ahead.id = "task-2".to_owned();
        state.add_task_snapshot(ahead).unwrap();
        assert_eq!(state.next_task_number, 3);
    }
}
