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

// Contract stage: the bodies below are `todo!()` until the state layer lands (port plan, step M1).
#![allow(unused_variables)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::TeamResult;

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
        todo!("M1: port of the decode half of foldTeam (src/team/state.ts)")
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
    todo!("M1: port of foldTeam (src/team/state.ts)")
}

/// Refuse a task graph that names a missing blocker (`TEAM_TASK_INVALID`) or contains a cycle
/// (`TEAM_TASK_CYCLE`).
pub fn assert_task_graph(tasks: &[TeamTaskSnapshot]) -> TeamResult<()> {
    todo!("M1: port of assertTaskGraph (src/team/state.ts)")
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
        todo!("M1: port of the dispatch in foldTeam (src/team/state.ts)")
    }

    /// Record one member snapshot, validating the lifecycle it describes.
    ///
    /// A new member must be provisioning, uniquely named and within `max_members`; a known member may move
    /// once, from provisioning to active or failed, and never changes its name.
    pub fn add_member(&mut self, member: TeamMemberSnapshot, max_members: usize) -> TeamResult<()> {
        todo!("M1: port of addMember (src/team/state.ts)")
    }

    /// Record one queued message, validating id uniqueness, sender (the Lead or an active member), target (the
    /// Lead or a member that is not failed), content and sender name.
    pub fn queue_message(&mut self, message: TeamMessageSnapshot) -> TeamResult<()> {
        todo!("M1: port of queueMessage (src/team/state.ts)")
    }

    /// Record that the target's own log accepted a queued message. A repeat is `TEAM_MESSAGE_DELIVERED`.
    pub fn mark_delivered(&mut self, message_id: &str, target_id: &str) -> TeamResult<()> {
        todo!("M1: port of markDelivered (src/team/state.ts)")
    }

    /// Record one complete task snapshot, checking its shape, revision continuity and the graph it makes.
    pub fn add_task_snapshot(&mut self, task: TeamTaskSnapshot) -> TeamResult<()> {
        todo!("M1: port of addTaskSnapshot (src/team/state.ts)")
    }

    /// Create a pending, unowned task with the next `task-<n>` id at revision 1; at most `max_tasks` tasks that
    /// are not deleted. Returns the snapshot to journal.
    pub fn create_task(
        &mut self,
        input: NewTask,
        max_tasks: usize,
    ) -> TeamResult<TeamTaskSnapshot> {
        todo!("M1: port of createTask (src/team/state.ts)")
    }

    /// A task is ready when it is pending and every blocker is completed. Readiness never starts anyone.
    pub fn is_ready(&self, task: &TeamTaskSnapshot) -> bool {
        todo!("M1: port of isReady (src/team/state.ts)")
    }

    /// Apply one compare-and-set action and return the task's new snapshot, to journal.
    ///
    /// The Lead may act on any task; a member on its own and on unowned work, never on another member's
    /// claim. `complete` is the owner's or the Lead's; `reassign` is the Lead's alone.
    pub fn apply_task_action(
        &mut self,
        request: &TaskActionRequest,
    ) -> TeamResult<TeamTaskSnapshot> {
        todo!("M1: port of applyTaskAction (src/team/state.ts)")
    }

    /// The task as a reader sees it, with readiness and advisory write-scope overlaps.
    pub fn task_view(&self, task: &TeamTaskSnapshot) -> TeamTaskView {
        todo!("M1: port of taskView (src/team/state.ts)")
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
        todo!("M1: port of resolveMember (src/team/state.ts)")
    }

    /// Members that are active or still provisioning — the set a wait can make progress on.
    pub fn active_or_provisioning(&self) -> Vec<&TeamMemberSnapshot> {
        todo!("M1: port of activeOrProvisioning (src/team/state.ts)")
    }

    /// Whether this message id has been delivered.
    pub fn is_delivered(&self, message_id: &str) -> bool {
        self.delivered.iter().any(|id| id == message_id)
    }

    /// Queued messages to this target that are not yet delivered.
    pub fn pending_for(&self, target_id: &str) -> usize {
        todo!("M2: the mailbox count send() checks against maxPendingMessagesPerMember")
    }
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
}
