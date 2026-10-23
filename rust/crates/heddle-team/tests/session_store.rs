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
use heddle_team::command::web_start_note;
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

    // The call the binary makes at `web` start, whose note heddle-server prints as `heddle web: <note>`.
    let note = web_start_note(&service).await;
    assert_eq!(
        note.map(|note| format!("heddle web: {note}")).as_deref(),
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
    let again = service_over(&store).recover_store().await;
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

/// The team panel's three lines as `src/server/page.html` (`refreshTeam`) derives them from `/api/team`, or
/// `None` when the page hides the panel (no teammate, no live task and no message).
fn panel_text(body: &Value) -> Option<(String, Vec<String>, String)> {
    let members = body["members"].as_array().cloned().unwrap_or_default();
    let teammates = members
        .iter()
        .filter(|member| member["role"] == "teammate")
        .count();
    let tasks: Vec<&Value> = body["tasks"]
        .as_array()
        .map(|tasks| {
            tasks
                .iter()
                .filter(|task| task["status"] != "deleted")
                .collect()
        })
        .unwrap_or_default();
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    if teammates == 0 && tasks.is_empty() && messages.is_empty() {
        return None;
    }
    let summary = format!("{teammates} teammate(s) \u{b7} {} task(s)", tasks.len());
    let board = tasks
        .iter()
        .map(|task| {
            let owner = task["ownerName"]
                .as_str()
                .map(|name| format!(" \u{b7} {name}"))
                .unwrap_or_default();
            let ready = if task["status"] == "pending" && task["ready"] == true {
                " \u{b7} ready"
            } else {
                ""
            };
            format!(
                "{} {} \u{b7} {}{owner}{ready}",
                task["id"].as_str().unwrap_or_default(),
                task["subject"].as_str().unwrap_or_default(),
                task["status"].as_str().unwrap_or_default()
            )
        })
        .collect();
    let delivered = body["delivered"].as_array().cloned().unwrap_or_default();
    let queued = messages
        .iter()
        .filter(|message| !delivered.contains(&message["id"]))
        .count();
    let mail = format!("{queued} queued \u{b7} {} delivered", delivered.len());
    Some((summary, board, mail))
}

#[test]
fn the_team_view_fixture_renders_the_roster_board_and_mailbox_the_check_reads() {
    // `_verifiers_/80-web-ui/check-team-view.mjs`'s fixture, event for event: the teammate first, the Lead
    // last, a three-revision task ending completed, and one delivered message. The check shapes its ids as
    // `session-<uuid>` because the HTTP session route refuses anything else; this test calls `team_view`
    // directly, so plain ids serve.
    let home = Scratch::new("view-home");
    let work = Scratch::new("view-work");
    let store = open_store(&home.0.join("sessions"));
    let lead = "session-view-lead";
    let member = "session-view-member";
    let member_handle = store
        .store
        .create(CreateOptions {
            id: Some(member.to_owned()),
            cwd: Some(work.text()),
            parent_session: Some(lead.to_owned()),
            origin: Some(SessionOrigin::Subagent),
            delegation_depth: Some(1),
            team_id: Some(lead.to_owned()),
            ..CreateOptions::default()
        })
        .expect("the teammate session");
    store
        .store
        .message(
            &member_handle,
            Message {
                role: Role::User,
                tool_call_id: None,
                content: vec![ContentPart::Text {
                    text: "the spawn prompt".to_owned(),
                }],
                source: None,
            },
        )
        .expect("the spawn prompt");
    store
        .append(
            member,
            json!({ "type": "assistant/completed", "text": "member done" }),
        )
        .expect("the teammate's answer");
    store
        .store
        .create(CreateOptions {
            id: Some(lead.to_owned()),
            cwd: Some(work.text()),
            endpoint: Some("scripted".to_owned()),
            model: Some("scripted".to_owned()),
            ..CreateOptions::default()
        })
        .expect("the Lead session");
    let alpha = |phase: &str| json!({ "id": member, "name": "alpha", "description": "the teammate", "context": "fresh", "phase": phase });
    let task = |revision: u64, status: &str, owner: Option<&str>| {
        let mut task = json!({ "id": "task-1", "revision": revision, "subject": "write the thing", "description": "", "status": status });
        if let Some(owner) = owner {
            task["ownerId"] = Value::from(owner);
        }
        task["blockedBy"] = json!([]);
        task["writeScopes"] = json!([]);
        task
    };
    for event in [
        json!({ "type": "team/member", "version": 2, "teamId": lead, "member": alpha("provisioning") }),
        json!({ "type": "team/member", "version": 2, "teamId": lead, "member": alpha("active") }),
        json!({ "type": "team/task", "version": 2, "teamId": lead, "task": task(1, "pending", None) }),
        json!({ "type": "team/task", "version": 2, "teamId": lead, "task": task(2, "in_progress", Some(member)) }),
        json!({ "type": "team/task", "version": 2, "teamId": lead, "task": task(3, "completed", Some(member)) }),
        json!({ "type": "team/message/queued", "version": 2, "teamId": lead, "message": { "id": "team-message-view-1", "senderId": lead, "senderName": "lead", "targetId": member, "content": [{ "type": "text", "text": "mailed" }] } }),
        json!({ "type": "team/message/delivered", "version": 2, "teamId": lead, "messageId": "team-message-view-1", "targetId": member }),
    ] {
        store
            .append(lead, event)
            .expect("the team event is journaled");
    }
    let service = service_over(&store);

    let body = serde_json::to_value(team_view(&service, lead).expect("the fixture folds"))
        .expect("the view serializes");
    let roster: Vec<(String, String, String)> = body["members"]
        .as_array()
        .expect("the roster is a list")
        .iter()
        .map(|member| {
            let field = |key: &str| member[key].as_str().unwrap_or_default().to_owned();
            (field("name"), field("role"), field("status"))
        })
        .collect();
    let expected: Vec<(String, String, String)> = [
        ("lead", "lead", "inactive"),
        ("alpha", "teammate", "inactive"),
    ]
    .into_iter()
    .map(|(name, role, status)| (name.to_owned(), role.to_owned(), status.to_owned()))
    .collect();
    assert_eq!(roster, expected, "view.roster");

    let (summary, board, mail) = panel_text(&body).expect("a team session shows its panel");
    assert!(summary.contains("1 teammate(s)"), "{summary}");
    assert_eq!(board.len(), 1);
    assert!(
        board[0].starts_with("task-1 write the thing"),
        "{}",
        board[0]
    );
    assert_eq!(body["tasks"][0]["status"], "completed");
    assert!(mail.contains("0 queued"), "{mail}");
    assert!(mail.contains("1 delivered"), "{mail}");

    // Asked about the teammate's own session, the answer is its team's; a session with no team hides the panel.
    let from_member =
        serde_json::to_value(team_view(&service, member).expect("the teammate's team folds"))
            .expect("the view serializes");
    assert_eq!(from_member["lead"], lead);
    let plain = store
        .store
        .create(CreateOptions {
            cwd: Some(work.text()),
            ..CreateOptions::default()
        })
        .expect("an ordinary session")
        .id;
    let ordinary =
        serde_json::to_value(team_view(&service, &plain).expect("an ordinary session folds"))
            .expect("the view serializes");
    assert_eq!(ordinary["members"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        panel_text(&ordinary),
        None,
        "a session with no team shows no panel"
    );
}

/// A `TeamAgent` that records a member turn's prompt the way `heddle-agent`'s `begin_turn` does, and runs no model.
struct PromptOnlyAgent {
    store: Arc<SessionTeamStore>,
}

impl heddle_team::plugin::TeamAgent for PromptOnlyAgent {
    fn begin_turn(
        &self,
        request: heddle_team::plugin::TeamTurnRequest,
    ) -> Result<TurnFuture, String> {
        self.store
            .user_message(
                &request.session,
                vec![json!({ "type": "text", "text": request.prompt })],
                request.source,
            )
            .map_err(|error| error.0)?;
        Ok(Box::pin(async { Ok(()) }))
    }

    fn default_endpoint(&self) -> Option<String> {
        Some("scripted".to_owned())
    }
}

/// **Kept on purpose, as the TypeScript build does it**: the collaboration policy is made durable on the Lead's
/// first team journal write, which happens while the Lead's first team tool call runs. So the note lands between
/// the assistant's tool call and that tool's result, and the next request reads `user, assistant, system, tool`.
/// Strict chat APIs refuse a tool call not followed directly by its result; whether the harness should move the
/// note is an open question about the TypeScript build, put to its owner (coordinator, 2026-10-22). The port
/// stays byte-faithful until that changes, and this test fails the day the order moves in either direction.
#[tokio::test]
async fn the_policy_note_lands_between_the_leads_first_team_tool_call_and_its_result_as_in_the_typescript_build()
 {
    let home = Scratch::new("order-home");
    let work = Scratch::new("order-work");
    let store = open_store(&home.0.join("sessions"));
    let lead = store
        .store
        .create(CreateOptions {
            cwd: Some(work.text()),
            endpoint: Some("scripted".to_owned()),
            ..CreateOptions::default()
        })
        .expect("the Lead session");
    let store_dependency: Arc<dyn TeamStore> = store.clone();
    let plugin = heddle_team::plugin::TeamPlugin::install(heddle_team::plugin::TeamPluginDeps {
        store: store_dependency,
        agent: Arc::new(PromptOnlyAgent {
            store: Arc::clone(&store),
        }),
        live: None,
        config: heddle_team::plugin::TeamConfig::default(),
        emit_changed: None,
        warn: None,
    });
    let message = |role: Role, content: Vec<ContentPart>, tool_call_id: Option<&str>| Message {
        role,
        tool_call_id: tool_call_id.map(str::to_owned),
        content,
        source: None,
    };
    let text = |text: &str| ContentPart::Text {
        text: text.to_owned(),
    };
    // The agent's order: the prompt, the assistant's tool call, the tool's run, then the tool's result.
    store
        .store
        .message(
            &lead,
            message(Role::User, vec![text("Lead: do the team work")], None),
        )
        .expect("the prompt");
    let call: ContentPart = serde_json::from_value(
        json!({ "type": "tool-call", "id": "call-1", "name": "spawn_teammate", "arguments": "{}" }),
    )
    .expect("a tool-call part");
    store
        .store
        .message(&lead, message(Role::Assistant, vec![call], None))
        .expect("the tool call");
    let outcome = plugin
        .tools
        .call(
            "spawn_teammate",
            &json!({ "name": "alpha", "description": "the teammate", "prompt": "write the thing" }),
            Some(&lead.id),
        )
        .await;
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    store
        .store
        .message(
            &lead,
            message(Role::Tool, vec![text(&outcome.output)], Some("call-1")),
        )
        .expect("the tool result");

    let messages = store
        .store
        .derive_messages(&lead)
        .expect("the Lead's surface derives");
    let roles: Vec<Role> = messages.iter().map(|message| message.role).collect();
    assert_eq!(
        roles,
        vec![Role::User, Role::Assistant, Role::System, Role::Tool],
        "the policy note sits between the tool call and its result, as in the TypeScript build"
    );
    assert!(
        serde_json::to_string(&messages[2].content)
            .expect("the note's content serializes")
            .contains("Agent Teams is available in this session"),
        "the system message is the team policy"
    );
}
