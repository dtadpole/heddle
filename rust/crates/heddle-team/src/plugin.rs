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

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::policy::{has_policy_note, policy_note_record};
use crate::ports::{PortError, TeamLive, TeamRunner, TeamSource, TeamStore, TurnFuture, UuidIds};
use crate::service::{RecoverAllReport, TeamDeps, TeamLimits, TeamNotify, TeamService, TeamWarn};
use crate::state::{DEFAULT_MAX_MEMBERS, DEFAULT_MAX_TASKS, SessionId};
use crate::tool::{OnSpawn, TeamToolOptions, TeamTools};

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
        let TeamPluginDeps {
            store,
            agent,
            live,
            config,
            emit_changed,
            warn,
        } = deps;
        // The runner resolves each member turn's endpoint and model from the member's own session metadata,
        // falling back to the profile's default endpoint.
        let runner: Arc<dyn TeamRunner> = Arc::new(AgentRunner {
            agent: Arc::clone(&agent),
            store: Arc::clone(&store),
        });
        // After every journal write the policy is made durable in the Lead's session and the change is
        // announced; after every spawn the policy is made durable for the Lead and the new member.
        let notify_store = Arc::clone(&store);
        let notify: TeamNotify = Arc::new(move |lead: &str| {
            let _ = ensure_policy(&*notify_store, &[lead]);
            if let Some(emit) = &emit_changed {
                emit(lead);
            }
        });
        let spawn_store = Arc::clone(&store);
        let on_spawn: OnSpawn = Arc::new(move |lead: &str, member: &str| {
            let _ = ensure_policy(&*spawn_store, &[lead, member]);
        });
        let service = Arc::new(TeamService::new(TeamDeps {
            store,
            runner,
            live,
            limits: TeamLimits::from(config),
            notify: Some(notify),
            warn,
            ids: Arc::new(UuidIds),
        }));
        let tools = TeamTools::new(
            Arc::clone(&service),
            TeamToolOptions {
                on_spawn: Some(on_spawn),
            },
        );
        Self { service, tools }
    }

    /// The `web` command's startup edge: recover every team in the store. Print
    /// [`RecoverAllReport::boot_line`] when it is `Some`. A one-shot command must not call this — it would
    /// start turns for teams it is not working on.
    pub async fn recover_at_boot(&self) -> RecoverAllReport {
        self.service.recover_store().await
    }
}

/// The [`TeamRunner`] the plugin composes over [`TeamAgent`]: one teammate turn, resolved against the member's
/// metadata and the profile's default endpoint.
struct AgentRunner {
    agent: Arc<dyn TeamAgent>,
    store: Arc<dyn TeamStore>,
}

impl TeamRunner for AgentRunner {
    fn begin(
        &self,
        session: &str,
        prompt: &str,
        source: &TeamSource,
    ) -> Result<TurnFuture, String> {
        let meta = self.store.meta(session);
        let endpoint = meta
            .as_ref()
            .and_then(|meta| meta.endpoint.clone())
            .or_else(|| self.agent.default_endpoint())
            .ok_or_else(|| NO_ENDPOINT_MESSAGE.to_owned())?;
        self.agent.begin_turn(TeamTurnRequest {
            session: session.to_owned(),
            endpoint,
            model: meta.as_ref().and_then(|meta| meta.model.clone()),
            prompt: prompt.to_owned(),
            purpose: TEAM_TURN_PURPOSE,
            source: source.to_value(),
        })
    }
}

/// Make the collaboration policy durable in each named session that exists and does not hold it yet
/// (`ensurePolicy`): append [`crate::policy::policy_note_record`] once per session.
pub fn ensure_policy(store: &dyn TeamStore, sessions: &[&str]) -> Result<(), PortError> {
    for id in sessions {
        if !store.exists(id) {
            continue;
        }
        if has_policy_note(&store.read(id)?) {
            continue;
        }
        store.append(id, policy_note_record())?;
    }
    Ok(())
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

    // --- M4: the plugin over the doubles ---

    use std::sync::Mutex as StdMutex;

    use crate::ports::{ChildSession, SessionMetaView, TeamStore};
    use crate::service::TeamMemberStatus;
    use crate::testing::MemoryStore;

    struct FakeAgent {
        default: Option<&'static str>,
        requests: StdMutex<Vec<TeamTurnRequest>>,
    }

    impl TeamAgent for FakeAgent {
        fn begin_turn(&self, request: TeamTurnRequest) -> Result<TurnFuture, String> {
            self.requests.lock().expect("the agent lock").push(request);
            Ok(Box::pin(async { Ok(()) }))
        }

        fn default_endpoint(&self) -> Option<String> {
            self.default.map(str::to_owned)
        }
    }

    struct Harness {
        plugin: TeamPlugin,
        store: Arc<MemoryStore>,
        agent: Arc<FakeAgent>,
        emitted: Arc<StdMutex<Vec<String>>>,
        lead: String,
    }

    fn harness(default_endpoint: Option<&'static str>, lead_endpoint: Option<&str>) -> Harness {
        let store = Arc::new(MemoryStore::new());
        let lead = "session-lead".to_owned();
        store.add_session(SessionMetaView {
            id: lead.clone(),
            cwd: Some("/work".to_owned()),
            endpoint: lead_endpoint.map(str::to_owned),
            model: Some("m".to_owned()),
            team_id: None,
        });
        let agent = Arc::new(FakeAgent {
            default: default_endpoint,
            requests: StdMutex::new(Vec::new()),
        });
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        let emit: TeamNotify = {
            let emitted = Arc::clone(&emitted);
            Arc::new(move |lead: &str| {
                emitted.lock().expect("the emit lock").push(lead.to_owned());
            })
        };
        let store_dependency: Arc<dyn TeamStore> = store.clone();
        let agent_dependency: Arc<dyn TeamAgent> = agent.clone();
        let plugin = TeamPlugin::install(TeamPluginDeps {
            store: store_dependency,
            agent: agent_dependency,
            live: None,
            config: TeamConfig::default(),
            emit_changed: Some(emit),
            warn: None,
        });
        Harness {
            plugin,
            store,
            agent,
            emitted,
            lead,
        }
    }

    async fn spawn_via_tools(h: &Harness, name: &str) -> String {
        let spawned = h
            .plugin
            .tools
            .call(
                "spawn_teammate",
                &json!({ "name": name, "description": "x", "prompt": "go" }),
                Some(&h.lead),
            )
            .await;
        assert!(spawned.error.is_none(), "{:?}", spawned.error);
        serde_json::from_str::<Value>(&spawned.output).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn policy_notes(h: &Harness, session: &str) -> usize {
        h.store
            .events(session)
            .iter()
            .filter(|event| {
                event["type"] == "context/note"
                    && event["origin"] == crate::policy::TEAM_POLICY_NOTE_ORIGIN
            })
            .count()
    }

    #[tokio::test]
    async fn install_makes_the_policy_durable_once_per_session_and_announces_the_change() {
        let h = harness(Some("scripted"), None);
        let member = spawn_via_tools(&h, "alpha").await;
        assert_eq!(
            policy_notes(&h, &h.lead),
            1,
            "the Lead holds the policy once"
        );
        assert_eq!(policy_notes(&h, &member), 1, "the member holds it once too");
        let emitted = h.emitted.lock().unwrap();
        assert!(emitted.iter().any(|lead| lead == &h.lead));
    }

    #[tokio::test]
    async fn a_member_turn_uses_the_members_endpoint_or_the_profiles_default() {
        let h = harness(Some("default-endpoint"), None);
        let member = spawn_via_tools(&h, "alpha").await;
        {
            let requests = h.agent.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].endpoint, "default-endpoint");
            assert_eq!(requests[0].purpose, TEAM_TURN_PURPOSE);
            assert_eq!(requests[0].session, member);
            assert_eq!(requests[0].model.as_deref(), Some("m"));
            assert_eq!(requests[0].source["kind"], "team-prompt");
            assert_eq!(requests[0].prompt, "go");
        }

        // A member whose session names an endpoint uses that one, not the default.
        let explicit = harness(Some("default-endpoint"), Some("lead-endpoint"));
        spawn_via_tools(&explicit, "alpha").await;
        let requests = explicit.agent.requests.lock().unwrap();
        assert_eq!(requests[0].endpoint, "lead-endpoint");
    }

    #[tokio::test]
    async fn no_endpoint_is_recorded_as_a_failed_turn_not_a_failed_member() {
        let h = harness(None, None);
        let member = spawn_via_tools(&h, "alpha").await;
        assert!(h.agent.requests.lock().unwrap().is_empty());
        let events = h.store.events(&member);
        assert!(events.iter().any(|event| {
            event["type"] == "turn/failed" && event["reason"] == NO_ENDPOINT_MESSAGE
        }));
        let roster = h.plugin.service.list(&h.lead).unwrap();
        assert_eq!(
            roster[1].status,
            TeamMemberStatus::Inactive,
            "the member still settled active; the turn is what failed"
        );
    }

    #[tokio::test]
    async fn recover_at_boot_settles_a_previous_processes_team_and_reports_it() {
        let h = harness(Some("scripted"), None);
        h.store
            .create(&ChildSession {
                id: "session-member".to_owned(),
                cwd: Some("/work".to_owned()),
                endpoint: None,
                model: None,
                parent_session: h.lead.clone(),
                origin: "subagent",
                delegation_depth: 1,
                team_id: h.lead.clone(),
                title: "teammate alpha".to_owned(),
            })
            .unwrap();
        h.store
            .user_message(
                "session-member",
                vec![json!({ "type": "text", "text": "spawn prompt" })],
                json!({ "kind": "team-prompt" }),
            )
            .unwrap();
        h.store
            .append(
                &h.lead,
                json!({
                    "type": "team/member",
                    "version": 2,
                    "teamId": h.lead,
                    "member": { "id": "session-member", "name": "alpha", "description": "x", "context": "fresh", "phase": "provisioning" },
                }),
            )
            .unwrap();
        let report = h.plugin.recover_at_boot().await;
        assert_eq!(report.recovered, 1);
        assert_eq!(report.settled, 1);
        assert_eq!(report.delivered, 0);
        assert_eq!(
            report.boot_line().as_deref(),
            Some("heddle web: recovered 1 team(s) (1 settled, 0 delivered)")
        );

        let empty = harness(Some("scripted"), None);
        assert_eq!(empty.plugin.recover_at_boot().await.boot_line(), None);
    }

    #[test]
    fn ensure_policy_appends_once_and_skips_a_missing_session() {
        let store = MemoryStore::new();
        store.add_session(SessionMetaView {
            id: "session-lead".to_owned(),
            ..SessionMetaView::default()
        });
        ensure_policy(&store, &["session-lead", "session-nowhere"]).unwrap();
        let notes = || {
            store
                .events("session-lead")
                .iter()
                .filter(|event| {
                    event["type"] == "context/note"
                        && event["origin"] == crate::policy::TEAM_POLICY_NOTE_ORIGIN
                })
                .count()
        };
        assert_eq!(notes(), 1);
        ensure_policy(&store, &["session-lead"]).unwrap();
        assert_eq!(notes(), 1, "the policy is written once, not once per write");
        assert!(store.events("session-nowhere").is_empty());
    }
}
