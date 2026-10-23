//! The team's refusals: one error type carrying a stable code.

use serde::{Deserialize, Serialize};

/// A stable refusal code.
///
/// A model reads the code in a tool result and a test asserts it, so every string is the TypeScript build's
/// (`TeamErrorCode` in `src/team/state.ts`) unchanged. The last two come from the tool layer
/// (`src/team/tool.ts`): a failure that is not a team rule, and a team tool called outside a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TeamErrorCode {
    /// A team event whose record version is not [`crate::state::TEAM_EVENT_VERSION`].
    #[serde(rename = "TEAM_VERSION_UNSUPPORTED")]
    VersionUnsupported,
    /// A team event whose `teamId` is not the session being folded.
    #[serde(rename = "TEAM_FOREIGN")]
    Foreign,
    /// An unknown `team/*` event type, a missing Lead session, or a member that vanished after a write.
    #[serde(rename = "TEAM_INVALID_EVENT")]
    InvalidEvent,
    /// A malformed member, an unknown or inactive member target, or a renamed member session.
    #[serde(rename = "TEAM_MEMBER_INVALID")]
    MemberInvalid,
    /// A second member with a name already taken.
    #[serde(rename = "TEAM_MEMBER_DUPLICATE")]
    MemberDuplicate,
    /// A lifecycle step that is not provisioning → active | failed, once.
    #[serde(rename = "TEAM_MEMBER_PHASE")]
    MemberPhase,
    /// A malformed task, a new task with the wrong id, or a blocker that does not exist.
    #[serde(rename = "TEAM_TASK_INVALID")]
    TaskInvalid,
    /// An action on a task id that is not on the board.
    #[serde(rename = "TEAM_TASK_MISSING")]
    TaskMissing,
    /// A task snapshot whose revision does not follow the previous one by exactly one.
    #[serde(rename = "TEAM_TASK_REVISION")]
    TaskRevision,
    /// A compare-and-set whose expected revision is not the task's current one.
    #[serde(rename = "TEAM_TASK_STALE")]
    TaskStale,
    /// A claim of a task whose blockers are not all completed.
    #[serde(rename = "TEAM_TASK_BLOCKED")]
    TaskBlocked,
    /// An action the task's status or ownership does not allow.
    #[serde(rename = "TEAM_TASK_STATUS")]
    TaskStatus,
    /// A blocker graph with a cycle, including a task that blocks itself.
    #[serde(rename = "TEAM_TASK_CYCLE")]
    TaskCycle,
    /// A malformed queued message, a duplicate, or a delivery whose target disagrees.
    #[serde(rename = "TEAM_MESSAGE_INVALID")]
    MessageInvalid,
    /// A delivery of a message that was never queued.
    #[serde(rename = "TEAM_MESSAGE_UNKNOWN")]
    MessageUnknown,
    /// A second delivery of one message.
    #[serde(rename = "TEAM_MESSAGE_DELIVERED")]
    MessageDelivered,
    /// The member cap or the live-task cap.
    #[serde(rename = "TEAM_LIMIT")]
    Limit,
    /// Spawn, interrupt or reassign by anyone but the Lead.
    #[serde(rename = "TEAM_LEAD_REQUIRED")]
    LeadRequired,
    /// A capability the profile does not provide: no live-turn registry, or no endpoint for a teammate turn.
    #[serde(rename = "TEAM_UNAVAILABLE")]
    Unavailable,
    /// A target with `maxPendingMessagesPerMember` undelivered messages already.
    #[serde(rename = "TEAM_MAILBOX_FULL")]
    MailboxFull,
    /// Message content larger than `maxMessageBytes` as JSON.
    #[serde(rename = "TEAM_MESSAGE_TOO_LARGE")]
    MessageTooLarge,
    /// A member sending to itself.
    #[serde(rename = "TEAM_SELF_MESSAGE")]
    SelfMessage,
    /// The tool layer's code for a failure that is not a team rule (a store or runner error).
    #[serde(rename = "TEAM_FAILED")]
    Failed,
    /// The tool layer's code for a team tool called without a session.
    #[serde(rename = "TEAM_NO_SESSION")]
    NoSession,
}

impl TeamErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [TeamErrorCode; 24] = [
        Self::VersionUnsupported,
        Self::Foreign,
        Self::InvalidEvent,
        Self::MemberInvalid,
        Self::MemberDuplicate,
        Self::MemberPhase,
        Self::TaskInvalid,
        Self::TaskMissing,
        Self::TaskRevision,
        Self::TaskStale,
        Self::TaskBlocked,
        Self::TaskStatus,
        Self::TaskCycle,
        Self::MessageInvalid,
        Self::MessageUnknown,
        Self::MessageDelivered,
        Self::Limit,
        Self::LeadRequired,
        Self::Unavailable,
        Self::MailboxFull,
        Self::MessageTooLarge,
        Self::SelfMessage,
        Self::Failed,
        Self::NoSession,
    ];

    /// The code as the model and the tests read it, e.g. `TEAM_TASK_STALE`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VersionUnsupported => "TEAM_VERSION_UNSUPPORTED",
            Self::Foreign => "TEAM_FOREIGN",
            Self::InvalidEvent => "TEAM_INVALID_EVENT",
            Self::MemberInvalid => "TEAM_MEMBER_INVALID",
            Self::MemberDuplicate => "TEAM_MEMBER_DUPLICATE",
            Self::MemberPhase => "TEAM_MEMBER_PHASE",
            Self::TaskInvalid => "TEAM_TASK_INVALID",
            Self::TaskMissing => "TEAM_TASK_MISSING",
            Self::TaskRevision => "TEAM_TASK_REVISION",
            Self::TaskStale => "TEAM_TASK_STALE",
            Self::TaskBlocked => "TEAM_TASK_BLOCKED",
            Self::TaskStatus => "TEAM_TASK_STATUS",
            Self::TaskCycle => "TEAM_TASK_CYCLE",
            Self::MessageInvalid => "TEAM_MESSAGE_INVALID",
            Self::MessageUnknown => "TEAM_MESSAGE_UNKNOWN",
            Self::MessageDelivered => "TEAM_MESSAGE_DELIVERED",
            Self::Limit => "TEAM_LIMIT",
            Self::LeadRequired => "TEAM_LEAD_REQUIRED",
            Self::Unavailable => "TEAM_UNAVAILABLE",
            Self::MailboxFull => "TEAM_MAILBOX_FULL",
            Self::MessageTooLarge => "TEAM_MESSAGE_TOO_LARGE",
            Self::SelfMessage => "TEAM_SELF_MESSAGE",
            Self::Failed => "TEAM_FAILED",
            Self::NoSession => "TEAM_NO_SESSION",
        }
    }
}

impl std::fmt::Display for TeamErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A refusal: a stable [`TeamErrorCode`] and a sentence a person or a model can act on.
///
/// The messages follow the TypeScript build's wording where it has one, so a transcript reads the same from
/// either build; the code is the contract, the message is not.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TeamError {
    pub code: TeamErrorCode,
    pub message: String,
}

impl TeamError {
    pub fn new(code: TeamErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The result of every fallible team operation.
pub type TeamResult<T> = Result<T, TeamError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_code_serializes_to_the_string_it_reports() {
        for code in TeamErrorCode::ALL {
            let json = serde_json::to_value(code).expect("a code serializes");
            assert_eq!(json, serde_json::Value::String(code.as_str().to_owned()));
            assert!(
                code.as_str().starts_with("TEAM_"),
                "{code} keeps the TEAM_ prefix"
            );
            let back: TeamErrorCode = serde_json::from_value(json).expect("a code deserializes");
            assert_eq!(back, code);
        }
    }

    #[test]
    fn the_codes_are_distinct() {
        let strings: HashSet<_> = TeamErrorCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        assert_eq!(strings.len(), TeamErrorCode::ALL.len());
    }

    #[test]
    fn an_error_displays_its_message_and_keeps_its_code() {
        let error = TeamError::new(
            TeamErrorCode::TaskStale,
            "task 'task-1' is at revision 2, not 1",
        );
        assert_eq!(error.to_string(), "task 'task-1' is at revision 2, not 1");
        assert_eq!(error.code, TeamErrorCode::TaskStale);
    }
}
