//! The team layer over the **real** session store (`heddle-session`), the closest this crate can get to
//! `_verifiers_/50-agentic-loop/check-teams.mjs` without the binary, the server or a model:
//!
//! - the second check's input is the recorded store a TypeScript process left behind, copied byte for byte from
//!   the verifier's own fixture folder, and recovered as the `web` boot edge recovers it;
//! - the first check's journal — spawn, the board, a message, and a restart — is driven through the nine tools
//!   and read back from disk with the claims the check makes.
//!
//! [`SessionTeamStore`] below is the `TeamStore` adapter the binary needs, written against `heddle-session`'s
//! public API; [`PromptOnlyRunner`] keeps `heddle-agent`'s `begin_turn` ordering (the prompt is in the member's
//! log before `begin` returns) without running a model.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use heddle_config::Env;
use heddle_session::{
    AppendOptions, ContentPart, CreateOptions, ForkAttribution, Message, NewEvent, Role,
    SessionHandle, SessionOrigin, SessionStore, workspace_key,
};
use heddle_team::api::team_view;
use heddle_team::ports::{
    ChildSession, PortError, SessionMetaView, TeamRunner, TeamSource, TeamStore, TurnFuture,
    UuidIds,
};
use heddle_team::service::{TeamDeps, TeamLimits};
use heddle_team::tool::TeamToolOptions;
use heddle_team::{TeamService, TeamTools, fold_team};
use serde_json::{Value, json};

/// `TeamStore` over `heddle_session::SessionStore`.
struct SessionTeamStore {
    store: SessionStore,
}

fn port(error: impl std::fmt::Display) -> PortError {
    PortError(error.to_string())
}

impl SessionTeamStore {
    fn handle(&self, session: &str) -> Result<SessionHandle, PortError> {
        self.store
            .open(session)
            .ok_or_else(|| PortError(format!("no session {session}")))
    }
}

impl TeamStore for SessionTeamStore {
    fn exists(&self, session: &str) -> bool {
        self.store.open(session).is_some()
    }

    fn read(&self, session: &str) -> Result<Vec<Value>, PortError> {
        let handle = self.handle(session)?;
        let events = self.store.read(&handle).map_err(port)?;
        Ok(events.iter().map(|event| event.to_value()).collect())
    }

    fn meta(&self, session: &str) -> Option<SessionMetaView> {
        self.store.meta(session).map(|meta| SessionMetaView {
            id: meta.id().to_owned(),
            cwd: Some(meta.cwd().to_owned()),
            endpoint: meta.endpoint().map(str::to_owned),
            model: meta.model().map(str::to_owned),
            team_id: meta.team_id().map(str::to_owned),
        })
    }

    fn list(&self) -> Vec<String> {
        self.store
            .list()
            .iter()
            .map(|meta| meta.id().to_owned())
            .collect()
    }

    fn create(&self, child: &ChildSession) -> Result<(), PortError> {
        self.store
            .create(CreateOptions {
                id: Some(child.id.clone()),
                cwd: child.cwd.clone(),
                endpoint: child.endpoint.clone(),
                model: child.model.clone(),
                title: Some(child.title.clone()),
                parent_session: Some(child.parent_session.clone()),
                origin: Some(SessionOrigin::Subagent),
                delegation_depth: Some(u64::from(child.delegation_depth)),
                team_id: Some(child.team_id.clone()),
                ..CreateOptions::default()
            })
            .map(|_| ())
            .map_err(port)
    }

    fn fork(&self, source: &str, child: &ChildSession) -> Result<bool, PortError> {
        self.store
            .fork(
                source,
                ForkAttribution {
                    parent_session: Some(child.parent_session.clone()),
                    origin: Some(SessionOrigin::Subagent),
                    delegation_depth: Some(u64::from(child.delegation_depth)),
                    team_id: Some(child.team_id.clone()),
                    title: Some(child.title.clone()),
                    id: Some(child.id.clone()),
                },
            )
            .map(|forked| forked.is_some())
            .map_err(port)
    }

    fn append(&self, session: &str, event: Value) -> Result<(), PortError> {
        let handle = self.handle(session)?;
        let event = NewEvent::try_from(event).map_err(port)?;
        self.store
            .append(&handle, event, AppendOptions::default())
            .map(|_| ())
            .map_err(port)
    }

    fn user_message(
        &self,
        session: &str,
        content: Vec<Value>,
        source: Value,
    ) -> Result<(), PortError> {
        let handle = self.handle(session)?;
        let content: Vec<ContentPart> =
            serde_json::from_value(Value::Array(content)).map_err(port)?;
        self.store
            .message(
                &handle,
                Message {
                    role: Role::User,
                    tool_call_id: None,
                    content,
                    source: Some(source),
                },
            )
            .map(|_| ())
            .map_err(port)
    }

    fn inherit_recorded_mode(&self, parent: &str, child: &str) -> Result<(), PortError> {
        let parent = self.handle(parent)?;
        let child = self.handle(child)?;
        heddle_session::inherit_recorded_mode::<Value>(&self.store, &parent, &child)
            .map(|_| ())
            .map_err(port)
    }
}

/// A runner with `begin_turn`'s ordering and no model: the prompt is in the member's log before it returns.
struct PromptOnlyRunner {
    store: Arc<SessionTeamStore>,
}

impl TeamRunner for PromptOnlyRunner {
    fn begin(
        &self,
        session: &str,
        prompt: &str,
        source: &TeamSource,
    ) -> Result<TurnFuture, String> {
        self.store
            .user_message(
                session,
                vec![json!({ "type": "text", "text": prompt })],
                source.to_value(),
            )
            .map_err(|error| error.0)?;
        Ok(Box::pin(async { Ok(()) }))
    }
}

/// A fresh scratch directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let dir =
            std::env::temp_dir().join(format!("heddle-team-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        Self(dir)
    }

    fn text(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn open_store(root: &Path) -> Arc<SessionTeamStore> {
    let env = Env::from_pairs(Vec::<(String, String)>::new());
    Arc::new(SessionTeamStore {
        store: SessionStore::new(&root.to_string_lossy(), &env),
    })
}

fn service_over(store: &Arc<SessionTeamStore>) -> Arc<TeamService> {
    let store_dependency: Arc<dyn TeamStore> = store.clone();
    Arc::new(TeamService::new(TeamDeps {
        store: store_dependency,
        runner: Arc::new(PromptOnlyRunner {
            store: Arc::clone(store),
        }),
        live: None,
        limits: TeamLimits::default(),
        notify: None,
        warn: None,
        ids: Arc::new(UuidIds),
    }))
}

/// The verifier's recorded store, written under `root` as check-teams' `materializeRecordedStore` writes it: the
/// logs byte for byte, each meta with its `cwd` replaced by the folder the process "ran" in.
fn materialize_recorded_store(root: &Path, work: &str) {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../_verifiers_/50-agentic-loop/fixtures/team-recover");
    let dir = root.join(workspace_key(work));
    std::fs::create_dir_all(&dir).expect("the workspace folder");
    let entries = std::fs::read_dir(&fixture).expect("the recorded fixture is checked in");
    for entry in entries {
        let path = entry.expect("a fixture entry").path();
        let name = path
            .file_name()
            .expect("a file name")
            .to_string_lossy()
            .into_owned();
        if name.ends_with(".json") {
            let text = std::fs::read_to_string(&path).expect("a recorded meta");
            let mut meta: Value = serde_json::from_str(&text).expect("a recorded meta is JSON");
            meta["cwd"] = Value::from(work);
            let mut written = serde_json::to_string_pretty(&meta).expect("a meta serializes");
            written.push('\n');
            std::fs::write(dir.join(&name), written).expect("the meta is written");
        } else if name.ends_with(".zstd") {
            std::fs::copy(&path, dir.join(&name)).expect("the log is copied byte for byte");
        }
    }
}

fn events_of(store: &SessionTeamStore, session: &str) -> Vec<Value> {
    store.read(session).expect("the session reads")
}

fn lines_of(store: &SessionTeamStore, session: &str) -> Vec<String> {
    let handle = store.handle(session).expect("the session exists");
    store
        .store
        .read(&handle)
        .expect("the session reads")
        .iter()
        .map(|event| event.to_line())
        .collect()
}

fn is_user_with(event: &Value, text: &str) -> bool {
    event["type"] == "message"
        && event["message"]["role"] == "user"
        && event["message"]["content"].to_string().contains(text)
}

#[tokio::test]
async fn boot_settles_and_delivers_what_a_typescript_process_left_behind() {
    let home = Scratch::new("recover-home");
    let work = Scratch::new("recover-work");
    let root = home.0.join("sessions");
    materialize_recorded_store(&root, &work.text());
    let store = open_store(&root);
    let service = service_over(&store);

    let report = service.recover_all(&store.list()).await;
    assert_eq!(
        report.boot_line().as_deref(),
        Some("heddle web: recovered 1 team(s) (2 settled, 1 delivered)"),
        "the line check-teams waits for"
    );

    let lead = events_of(&store, "session-recover-lead");
    let phases: Vec<(String, String)> = lead
        .iter()
        .filter(|event| event["type"] == "team/member")
        .map(|event| {
            (
                event["member"]["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                event["member"]["phase"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            )
        })
        .collect();
    let expected: Vec<(String, String)> = [
        ("alpha", "provisioning"),
        ("ghost", "provisioning"),
        ("alpha", "active"),
        ("ghost", "failed"),
    ]
    .into_iter()
    .map(|(name, phase)| (name.to_owned(), phase.to_owned()))
    .collect();
    assert_eq!(phases, expected);
    let delivered: Vec<&str> = lead
        .iter()
        .filter(|event| event["type"] == "team/message/delivered")
        .filter_map(|event| event["messageId"].as_str())
        .collect();
    assert_eq!(delivered, vec!["team-message-left-1"]);
    assert!(
        events_of(&store, "session-recover-active")
            .iter()
            .any(|event| {
                event["message"]["source"]["kind"] == "team-message"
                    && event["message"]["source"]["messageId"] == "team-message-left-1"
            }),
        "the queued mail reached the member's own log with its team-message source"
    );

    // What this process journaled keeps the TypeScript key order on disk.
    let lines = lines_of(&store, "session-recover-lead");
    let settled = lines
        .iter()
        .find(|line| line.contains(r#""phase":"active""#))
        .expect("the settled member is journaled");
    assert!(
        settled.contains(r#""type":"team/member","member":{"id":"session-recover-active","name":"alpha","description":"left over","context":"fresh","phase":"active"},"version":2,"teamId":"session-recover-lead"}"#),
        "{settled}"
    );
    let delivery = lines
        .iter()
        .find(|line| line.contains("team/message/delivered"))
        .expect("the delivery is journaled");
    assert!(
        delivery.ends_with(r#""type":"team/message/delivered","messageId":"team-message-left-1","targetId":"session-recover-active","version":2,"teamId":"session-recover-lead"}"#),
        "{delivery}"
    );

    // Booting again on the same store recovers the team with nothing left to do, and a fresh store re-reading
    // the disk still folds the log strictly.
    let again = service_over(&store).recover_all(&store.list()).await;
    assert_eq!(
        again.boot_line().as_deref(),
        Some("heddle web: recovered 1 team(s) (0 settled, 0 delivered)")
    );
    let reread = open_store(&root);
    let state = fold_team(
        &events_of(&reread, "session-recover-lead"),
        "session-recover-lead",
    )
    .expect("the log folds after a restart");
    assert_eq!(state.delivered, vec!["team-message-left-1".to_owned()]);
}

#[tokio::test]
async fn a_lead_spawns_tasks_and_messages_through_the_tools_and_the_team_survives_a_restart() {
    let home = Scratch::new("e2e-home");
    let work = Scratch::new("e2e-work");
    let root = home.0.join("sessions");
    let store = open_store(&root);
    let lead = store
        .store
        .create(CreateOptions {
            cwd: Some(work.text()),
            endpoint: Some("scripted".to_owned()),
            model: Some("scripted".to_owned()),
            ..CreateOptions::default()
        })
        .expect("the Lead session")
        .id;
    let service = service_over(&store);
    let tools = TeamTools::new(Arc::clone(&service), TeamToolOptions::default());

    // The tool calls the check scripts for the Lead's turn, in its order.
    let calls = [
        (
            "spawn_teammate",
            json!({ "name": "alpha", "description": "the teammate", "prompt": "write the thing" }),
        ),
        (
            "team_task_create",
            json!({ "subject": "write the thing", "write_scopes": ["src/team"] }),
        ),
        (
            "team_task_update",
            json!({ "task_id": "task-1", "revision": 1, "action": "claim" }),
        ),
        (
            "team_task_update",
            json!({ "task_id": "task-1", "revision": 2, "action": "complete" }),
        ),
        (
            "send_message",
            json!({ "target": "alpha", "message": "the board is clear" }),
        ),
        ("list_agents", json!({})),
    ];
    let mut child = String::new();
    for (name, args) in calls {
        let outcome = tools.call(name, &args, Some(&lead)).await;
        assert!(outcome.error.is_none(), "{name}: {:?}", outcome.error);
        if name == "spawn_teammate" {
            child = outcome.data.as_ref().expect("the spawn reports its member")["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
        }
        if name == "send_message" {
            assert_eq!(
                outcome.data.as_ref().expect("a send reports")["status"],
                "accepted"
            );
        }
    }

    // The teammate's own meta, read from the file beside its log, as the check reads it.
    let handle = store.handle(&child).expect("the teammate session exists");
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(&handle.meta).expect("the meta file"))
            .expect("the meta is JSON");
    assert_eq!(meta["teamId"], Value::from(lead.as_str()));
    assert_eq!(meta["parentSession"], Value::from(lead.as_str()));
    assert_eq!(meta["origin"], "subagent");
    assert_eq!(meta["delegationDepth"], 1);
    assert_eq!(meta["title"], "teammate alpha");

    let lead_events = events_of(&store, &lead);
    let member_events = lead_events
        .iter()
        .filter(|event| event["type"] == "team/member")
        .count();
    assert!(
        member_events >= 2,
        "the member is journaled provisioning then active"
    );
    let tasks: Vec<(String, u64, String)> = lead_events
        .iter()
        .filter(|event| event["type"] == "team/task")
        .map(|event| {
            (
                event["task"]["id"].as_str().unwrap_or_default().to_owned(),
                event["task"]["revision"].as_u64().unwrap_or_default(),
                event["task"]["status"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            )
        })
        .collect();
    let expected: Vec<(String, u64, String)> =
        [(1, "pending"), (2, "in_progress"), (3, "completed")]
            .into_iter()
            .map(|(revision, status)| ("task-1".to_owned(), revision, status.to_owned()))
            .collect();
    assert_eq!(tasks, expected);
    let claimed = lead_events
        .iter()
        .filter(|event| event["type"] == "team/task")
        .nth(1)
        .expect("the claim is journaled");
    assert_eq!(
        claimed["task"]["ownerId"],
        Value::from(lead.as_str()),
        "the Lead claimed it"
    );
    let count = |kind: &str| {
        lead_events
            .iter()
            .filter(|event| event["type"] == kind)
            .count()
    };
    assert_eq!(count("team/message/queued"), 1);
    assert_eq!(count("team/message/delivered"), 1);

    let child_events = events_of(&store, &child);
    assert!(
        child_events
            .iter()
            .any(|event| is_user_with(event, "write the thing")),
        "the spawn prompt"
    );
    assert!(
        child_events
            .iter()
            .any(|event| is_user_with(event, "the board is clear")),
        "the mailed message"
    );
    assert!(
        child_events
            .iter()
            .any(|event| event["message"]["source"]["kind"] == "team-message"),
        "the mailed message carries its team-message source"
    );

    let view = team_view(&service, &lead).expect("the team view folds");
    let roster: Vec<(String, String)> = serde_json::to_value(&view.members)
        .expect("the roster serializes")
        .as_array()
        .expect("the roster is a list")
        .iter()
        .map(|member| {
            (
                member["name"].as_str().unwrap_or_default().to_owned(),
                member["role"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        roster,
        vec![
            ("lead".to_owned(), "lead".to_owned()),
            ("alpha".to_owned(), "teammate".to_owned())
        ]
    );

    // Restart on the same store: the team is durable, and the boot edge recovers it.
    let restarted = open_store(&root);
    let service = service_over(&restarted);
    let report = service.recover_all(&restarted.list()).await;
    assert_eq!(report.recovered, 1);
    assert!(
        report
            .boot_line()
            .is_some_and(|line| line.contains("recovered 1 team(s)")),
        "{report:?}"
    );
    let view = team_view(&service, &lead).expect("the team view folds after the restart");
    assert_eq!(view.members.len(), 2, "the roster survived the restart");
    assert_eq!(
        serde_json::to_value(&view.tasks[0]).expect("a task serializes")["status"],
        "completed",
        "the board survived the restart"
    );
}
