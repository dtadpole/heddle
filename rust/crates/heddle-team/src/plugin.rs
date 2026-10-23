//! The **plugin**: what the profile row `team` installs.
//!
//! Port of `src/plugins/team.ts`. It builds the service with a turn runner and the live-turn registry, makes
//! the nine tools, makes the collaboration policy durable on every journal write and for every new member,
//! announces `team/changed`, and offers the boot recovery the `web` command runs.
//!
//! The row is **opt-in**: a profile that omits it runs no teams and the nine tools never reach the model.
//! The binary composes it from adapters over the crates that own each capability (see [`crate::ports`]):
//!
//! ```text
//! TeamPlugin::install(TeamPluginDeps {
//!     store:        <heddle-session adapter>,          // TeamStore
//!     agent:        <heddle-agent adapter>,            // TeamAgent (begin a turn, default endpoint)
//!     live:         Some(<heddle-agent turn registry>), // TeamLive, or None
//!     config:       <the `team` row, deserialized>,    // TeamConfig
//!     emit_changed: Some(<heddle-events emit "team/changed">),
//!     warn:         Some(<logger warn>),
//! })
//! // register plugin.tools' nine specs with heddle-tools; serve api::team_api at GET /api/team;
//! // in `web`, after goals resume: if let Some(line) = plugin.recover_at_boot().await.boot_line() { println!("{line}") }
//! ```

// Contract stage: the bodies below are `todo!()` until the plugin lands (port plan, step M4).
#![allow(unused_variables)]

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ports::{PortError, TeamLive, TeamStore, TurnFuture};
use crate::service::{RecoverAllReport, TeamLimits, TeamNotify, TeamService, TeamWarn};
use crate::state::{DEFAULT_MAX_MEMBERS, DEFAULT_MAX_TASKS, SessionId};
use crate::tool::TeamTools;

/// The profile row that installs teams.
pub const PROFILE_ROW: &str = "team";

/// The event announced after every journal write, with the Lead's session id.
pub const TEAM_CHANGED_EVENT: &str = "team/changed";

/// The `purpose` of a teammate's automatic turn; it reaches the model call unchanged, so a backend (or the
/// scripted endpoint of the verifiers) can answer a teammate differently from the Lead.
pub const TEAM_TURN_PURPOSE: &str = "team";

/// The message of the refusal when neither the member's session nor the profile names an endpoint.
pub const NO_ENDPOINT_MESSAGE: &str = "no endpoint is configured for a teammate turn";

/// The `team` row's configuration, camelCase keys, every key optional.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TeamConfig {
    pub max_members: usize,
    pub max_tasks: usize,
    pub max_pending_messages_per_member: usize,
    pub max_message_bytes: usize,
}

impl Default for TeamConfig {
    fn default() -> Self {
        Self {
            max_members: DEFAULT_MAX_MEMBERS,
            max_tasks: DEFAULT_MAX_TASKS,
            max_pending_messages_per_member: 64,
            max_message_bytes: 65_536,
        }
    }
}

impl From<TeamConfig> for TeamLimits {
    fn from(config: TeamConfig) -> Self {
        Self {
            max_members: config.max_members,
            max_tasks: config.max_tasks,
            max_pending_messages_per_member: config.max_pending_messages_per_member,
            max_message_bytes: config.max_message_bytes,
        }
    }
}

/// One teammate turn, as the plugin asks the agent loop for it (`runTurn(ctx, { session, endpoint, prompt,
/// purpose: 'team', source, model? })`).
#[derive(Debug, Clone, PartialEq)]
pub struct TeamTurnRequest {
    pub session: SessionId,
    /// The member session's endpoint, else the profile's default.
    pub endpoint: String,
    /// The member session's model, when its metadata names one.
    pub model: Option<String>,
    pub prompt: String,
    /// Always [`TEAM_TURN_PURPOSE`].
    pub purpose: &'static str,
    /// The [`crate::ports::TeamSource`] as JSON, to store verbatim on the turn's user message.
    pub source: Value,
}

/// The agent loop, as the plugin uses it. Implemented over `heddle-agent`.
pub trait TeamAgent: Send + Sync {
    /// Begin one turn, with the same ordering promise as [`crate::ports::TeamRunner::begin`]: the prompt is in
    /// the session's log (with `source`) and the turn is registered live before this returns.
    fn begin_turn(&self, request: TeamTurnRequest) -> Result<TurnFuture, String>;

    /// The profile's default endpoint, used when a member's session names none.
    fn default_endpoint(&self) -> Option<String>;
}

/// What [`TeamPlugin::install`] composes.
pub struct TeamPluginDeps {
    pub store: Arc<dyn TeamStore>,
    pub agent: Arc<dyn TeamAgent>,
    pub live: Option<Arc<dyn TeamLive>>,
    pub config: TeamConfig,
    /// Announces [`TEAM_CHANGED_EVENT`] on the event bus.
    pub emit_changed: Option<TeamNotify>,
    pub warn: Option<TeamWarn>,
}

/// The installed team layer.
pub struct TeamPlugin {
    pub service: Arc<TeamService>,
    pub tools: TeamTools,
}

impl TeamPlugin {
    /// Build the service and the tools.
    ///
    /// The runner resolves each member turn's endpoint and model from the member's session metadata (falling
    /// back to the agent's default endpoint, else refusing with [`NO_ENDPOINT_MESSAGE`]) and begins it with
    /// purpose [`TEAM_TURN_PURPOSE`]. After every journal write the policy is made durable in the Lead's
    /// session and `team/changed` is announced; after every spawn the policy is made durable for the Lead and
    /// the new member.
    pub fn install(deps: TeamPluginDeps) -> Self {
        todo!("M4: port of apply (src/plugins/team.ts)")
    }

    /// The `web` command's startup edge: recover every team in the store. Print
    /// [`RecoverAllReport::boot_line`] when it is `Some`. A one-shot command must not call this — it would
    /// start turns for teams it is not working on.
    pub async fn recover_at_boot(&self) -> RecoverAllReport {
        todo!("M4: port of the team half of the web command's boot (src/cli.ts)")
    }
}

/// Make the collaboration policy durable in each named session that exists and does not hold it yet
/// (`ensurePolicy`): append [`crate::policy::policy_note_record`] once per session.
pub fn ensure_policy(store: &dyn TeamStore, sessions: &[&str]) -> Result<(), PortError> {
    todo!("M4: port of ensurePolicy (src/plugins/team.ts)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_empty_row_takes_the_typescript_defaults() {
        let config: TeamConfig = serde_json::from_value(json!({})).expect("an empty row decodes");
        assert_eq!(config, TeamConfig::default());
        assert_eq!(TeamLimits::from(config), TeamLimits::default());
    }

    #[test]
    fn a_row_overrides_by_camel_case_key() {
        let config: TeamConfig =
            serde_json::from_value(json!({ "maxMembers": 3, "maxMessageBytes": 1024 }))
                .expect("the row decodes");
        assert_eq!(config.max_members, 3);
        assert_eq!(config.max_message_bytes, 1024);
        assert_eq!(config.max_tasks, 256, "an omitted key keeps its default");
    }
}
