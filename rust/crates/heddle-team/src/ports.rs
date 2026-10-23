//! The seams this crate needs from the rest of the harness, as traits it owns.
//!
//! The team layer is written against these and tested against in-memory doubles
//! (`crate::testing`, feature `test-doubles`). The binary composes the real implementations as thin
//! adapters over the crates that own them:
//!
//! | Port | Implemented over | What the TypeScript build used |
//! |---|---|---|
//! | [`TeamStore`] | `heddle-session` | `SessionStore` and `inheritRecordedMode` (`src/session/`) |
//! | [`TeamRunner`] | `heddle-agent`, through [`crate::plugin::TeamAgent`] | `runTurn` (`src/agent/loop.ts`) |
//! | [`TeamLive`] | `heddle-agent`'s live-turn registry | `TurnRegistry` (`src/agent/turns.ts`) |
//! | [`TeamIds`] | [`UuidIds`] here | `randomUUID()` |
//!
//! Sessions are named by id at this boundary; an adapter maps an id to whatever handle its store uses.

use std::future::Future;
use std::pin::Pin;

use serde::Serialize;
use serde_json::Value;

use crate::state::SessionId;

/// A failure of a port's implementation — an I/O error, a missing session, a refused write. It reaches a
/// model as `TEAM_FAILED` with this message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PortError(pub String);

impl From<PortError> for crate::error::TeamError {
    fn from(error: PortError) -> Self {
        crate::error::TeamError::new(crate::error::TeamErrorCode::Failed, error.0)
    }
}

/// What the team reads from a session's metadata record.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionMetaView {
    pub id: SessionId,
    pub cwd: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    /// The team this session belongs to (its Lead's id), when it is a teammate's.
    pub team_id: Option<SessionId>,
}

/// The metadata a teammate's session is created with: the attribution DSH's `childSessionMeta` writes, plus
/// the team.
///
/// For a `fresh` member the service fills `cwd`, `endpoint` and `model` from the Lead's metadata; for a `fork`
/// the store takes them from the source session, as `SessionStore.fork` does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSession {
    /// Chosen by the service before the session exists, so the journal can name it first.
    pub id: SessionId,
    pub cwd: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    /// The Lead's session id.
    pub parent_session: SessionId,
    /// Always `subagent`.
    pub origin: &'static str,
    /// Always 1.
    pub delegation_depth: u32,
    /// The Lead's session id.
    pub team_id: SessionId,
    /// `teammate <name>`.
    pub title: String,
}

/// The session store, as the team uses it. Port of the parts of `SessionStore` the TypeScript service calls.
///
/// Every method is synchronous and must be safe to call from several threads; the service serializes its own
/// read-fold-append sequences per Lead, but other writers (a turn) append to the same logs concurrently.
pub trait TeamStore: Send + Sync {
    /// Whether the session exists (`open(id) !== null`).
    fn exists(&self, session: &str) -> bool;

    /// Every event of the session's log, in order, each the JSON object of one log line (with `seq`, `at`,
    /// `type`). An error when the session does not exist.
    fn read(&self, session: &str) -> Result<Vec<Value>, PortError>;

    /// The session's metadata record, or `None` when there is no such session.
    fn meta(&self, session: &str) -> Option<SessionMetaView>;

    /// Every session id in the store, for the boot recovery sweep.
    fn list(&self) -> Vec<SessionId>;

    /// Create an empty session with exactly this id and metadata.
    fn create(&self, child: &ChildSession) -> Result<(), PortError>;

    /// Create a session that starts from `source`'s completed turns (`SessionStore.fork`). `Ok(false)` when
    /// `source` cannot be read.
    fn fork(&self, source: &str, child: &ChildSession) -> Result<bool, PortError>;

    /// Append one event; the store adds `seq` and `at` in front of the given keys.
    fn append(&self, session: &str, event: Value) -> Result<(), PortError>;

    /// Record a user message `{ role: 'user', content, source }` (`SessionStore.message`, which also counts the
    /// turn). `source` is stored verbatim.
    fn user_message(
        &self,
        session: &str,
        content: Vec<Value>,
        source: Value,
    ) -> Result<(), PortError>;

    /// Give `child` the permission mode `parent` recorded, if it recorded one (`inheritRecordedMode`), so a
    /// read-only team cannot spawn a teammate that writes.
    fn inherit_recorded_mode(&self, parent: &str, child: &str) -> Result<(), PortError>;
}

/// The rest of a turn after [`TeamRunner::begin`] returned. An `Err` is recorded in the session as
/// `{ type: 'turn/failed', reason }` by the service.
pub type TurnFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>>;

/// Starts turns in a member's session.
pub trait TeamRunner: Send + Sync {
    /// Begin one turn in `session` with `prompt`.
    ///
    /// **Before returning**, the prompt must be in the session's own log as the user message
    /// `{ role: 'user', content: [{ type: 'text', text: prompt }], source }` with `source` verbatim, and the
    /// turn must be registered live ([`TeamLive::is_running`] is true). The service reads the log right after
    /// this call: that read is how delivery is proven and how "provisioning left a resumable session" is
    /// judged later. The TypeScript build got this ordering from `runTurn` appending before its first `await`;
    /// a Rust future does nothing until polled, so the split into a synchronous begin and a future is explicit.
    ///
    /// An `Err` here is recorded like a failed future: as `turn/failed` in the session, never thrown to the
    /// caller.
    fn begin(&self, session: &str, prompt: &str, source: &TeamSource)
    -> Result<TurnFuture, String>;
}

/// The live half of status and interruption: what only this process knows. Optional — a profile without the
/// live-turn registry runs teams with status limited to durable phases and no interruption.
pub trait TeamLive: Send + Sync {
    /// Whether the session has a turn in flight right now.
    fn is_running(&self, session: &str) -> bool;
    /// Stop every turn in flight for the session; whether there was one.
    fn abort(&self, session: &str) -> bool;
}

/// Where new ids come from; injected so tests are deterministic.
pub trait TeamIds: Send + Sync {
    /// A new teammate session id, `session-<uuid>`.
    fn session_id(&self) -> SessionId;
    /// A new message id, `team-message-<uuid>`.
    fn message_id(&self) -> String;
}

/// The production [`TeamIds`]: random version-4 UUIDs, as `randomUUID()` gave the TypeScript build.
#[derive(Debug, Clone, Copy, Default)]
pub struct UuidIds;

impl TeamIds for UuidIds {
    fn session_id(&self) -> SessionId {
        format!("session-{}", uuid::Uuid::new_v4())
    }

    fn message_id(&self) -> String {
        format!("team-message-{}", uuid::Uuid::new_v4())
    }
}

/// The `source` a team turn's user message carries, so a reader of the member's log can tell who wrote it.
///
/// Serialized with `kind` first, as the TypeScript build writes it:
/// `{ kind: 'team-prompt', teamId, memberId }` for a spawn's first prompt, and
/// `{ kind: 'team-message', teamId, messageId, senderId, senderName }` for delivered mail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum TeamSource {
    #[serde(rename = "team-prompt", rename_all = "camelCase")]
    Prompt {
        team_id: SessionId,
        member_id: SessionId,
    },
    #[serde(rename = "team-message", rename_all = "camelCase")]
    Message {
        team_id: SessionId,
        message_id: String,
        sender_id: SessionId,
        sender_name: String,
    },
}

impl TeamSource {
    /// The `kind` value of a delivered message's source; delivery proof looks for it.
    pub const MESSAGE_KIND: &'static str = "team-message";

    /// The source as the JSON stored on the user message.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("a team source serializes to JSON")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn is_uuid_v4(text: &str) -> bool {
        uuid::Uuid::parse_str(text).is_ok_and(|id| id.get_version_num() == 4)
    }

    #[test]
    fn uuid_ids_have_the_typescript_prefixes_and_are_fresh() {
        let ids = UuidIds;
        let session = ids.session_id();
        let message = ids.message_id();
        assert!(
            session.strip_prefix("session-").is_some_and(is_uuid_v4),
            "{session}"
        );
        assert!(
            message
                .strip_prefix("team-message-")
                .is_some_and(is_uuid_v4),
            "{message}"
        );
        assert_ne!(ids.session_id(), session);
    }

    #[test]
    fn a_source_serializes_with_its_kind_and_camel_case_fields() {
        let prompt = TeamSource::Prompt {
            team_id: "session-a".into(),
            member_id: "session-b".into(),
        };
        assert_eq!(
            prompt.to_value(),
            json!({ "kind": "team-prompt", "teamId": "session-a", "memberId": "session-b" })
        );
        let message = TeamSource::Message {
            team_id: "session-a".into(),
            message_id: "team-message-1".into(),
            sender_id: "session-a".into(),
            sender_name: "lead".into(),
        };
        let value = message.to_value();
        assert_eq!(value["kind"], TeamSource::MESSAGE_KIND);
        assert_eq!(
            value,
            json!({ "kind": "team-message", "teamId": "session-a", "messageId": "team-message-1", "senderId": "session-a", "senderName": "lead" })
        );
    }

    #[test]
    fn a_port_error_reaches_the_model_as_team_failed() {
        let error: crate::error::TeamError = PortError("disk full".into()).into();
        assert_eq!(error.code, crate::error::TeamErrorCode::Failed);
        assert_eq!(error.message, "disk full");
    }
}
