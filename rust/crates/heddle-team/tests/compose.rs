//! The `team` row composed over the real crates (feature `compose`), driven by a real Lead turn.
//!
//! The runtime is the one the binary's `agent_runtime` builds — `heddle-llm`'s model service on a scripted
//! endpoint, `heddle-session`'s service, `heddle-context`'s service over the session store, and `heddle-tools`'
//! registry gated by `heddle-sandbox`'s sandbox and approvals — and the row starts through
//! `heddle_team::compose::start_row`. The Lead's turn then runs `_verifiers_/50-agentic-loop/check-teams.mjs`'s
//! first script through `heddle-agent`'s loop, and the test asserts that check's claims. What it does not
//! include is the binary's boot and the HTTP server.
#![cfg(feature = "compose")]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use heddle_agent::{AgentRuntime, RunTurnOptions, TurnRegistry};
use heddle_config::{EndpointConfig, Env};
use heddle_context::{ContextConfig, ContextDependencies, ContextService};
use heddle_llm::ModelService;
use heddle_sandbox::{
    ApprovalMode, ApprovalService, ApprovalsConfig, BackendChoice, Platform, SandboxConfig,
    SandboxHost, SandboxMode, SandboxService,
};
use heddle_server::services::TeamService as ServerTeamPort;
use heddle_session::{CreateOptions, SessionConfig, SessionService};
use heddle_team::command::web_start_note;
use heddle_team::compose::{ServerTeam, TeamRow, start_row};
use heddle_team::tool::TEAM_TOOL_NAMES;
use heddle_tools::ToolRegistry;
use serde_json::{Value, json};

/// A fresh scratch directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "heddle-team-compose-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        Self(std::fs::canonicalize(&dir).expect("a canonical scratch path"))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The booted services a turn and the team row need, as the binary registers them.
struct Booted {
    sessions: Arc<SessionService>,
    models: Arc<ModelService>,
    runtime: Arc<AgentRuntime>,
}

fn boot(home: &Path, work: &Path, steps: Value) -> Booted {
    let script = home.join("script.json");
    std::fs::write(&script, json!({ "steps": steps }).to_string()).expect("the script");
    let env = Env::from_pairs([
        ("HEDDLE_HOME", home.to_string_lossy().into_owned()),
        ("HOME", home.to_string_lossy().into_owned()),
    ]);
    let endpoint: EndpointConfig = serde_json::from_value(json!({
        "name": "scripted",
        "kind": "scripted",
        "baseUrl": script.to_string_lossy(),
        "model": "scripted",
    }))
    .expect("a scripted endpoint");
    let models = Arc::new(ModelService::new(vec![endpoint]).expect("the model service"));
    let sessions = Arc::new(SessionService::new(
        &SessionConfig {
            root: Some(home.join("sessions").to_string_lossy().into_owned()),
        },
        &env,
        None,
    ));
    let context_config: ContextConfig =
        serde_json::from_value(json!({})).expect("the context row's defaults");
    let context = Arc::new(ContextService::new(
        Arc::clone(sessions.store()),
        context_config,
        ContextDependencies {
            model: None,
            heddle_home: home.to_path_buf(),
        },
    ));
    let sandbox = Arc::new(SandboxService::with_backend(
        &SandboxConfig {
            mode: SandboxMode::WorkspaceWrite,
            workspace_root: Some(work.to_path_buf()),
            backend: BackendChoice::Disabled,
            ..SandboxConfig::default()
        },
        &SandboxHost {
            cwd: work.to_path_buf(),
            harness_home: home.join(".heddle"),
            platform: Platform::current(),
        },
        None,
    ));
    // The default profile's approvals row: `mode: allow`.
    let approvals = Arc::new(ApprovalService::new(ApprovalsConfig {
        mode: ApprovalMode::Allow,
        ..ApprovalsConfig::default()
    }));
    let registry = Arc::new(ToolRegistry::new(heddle_tools::adapters::gates_over(
        sandbox,
        approvals,
        Arc::clone(&sessions),
    )));
    let runtime = Arc::new(AgentRuntime {
        model: Arc::new(heddle_agent::adapters::LlmModel::new(Arc::clone(&models))),
        session: Arc::new(heddle_agent::adapters::Sessions::new(Arc::clone(&sessions))),
        context: Arc::new(heddle_agent::adapters::Context::over_session_handles(
            context,
        )),
        tools: registry,
        hooks: Arc::new(heddle_agent::NoTurnHooks),
        turns: Some(TurnRegistry::new()),
        presets: None,
    });
    Booted {
        sessions,
        models,
        runtime,
    }
}

fn start(booted: &Booted) -> heddle_team::TeamPlugin {
    start_row(TeamRow {
        config: &json!({}),
        sessions: Arc::clone(&booted.sessions),
        models: Arc::clone(&booted.models),
        runtime: booted.runtime.clone(),
        emit_changed: None,
        warn: None,
    })
    .expect("the team row starts")
}

fn events(booted: &Booted, session: &str) -> Vec<Value> {
    let store = booted.sessions.store();
    let handle = store.open(session).expect("the session exists");
    store
        .read(&handle)
        .expect("the session reads")
        .iter()
        .map(|event| event.to_value())
        .collect()
}

fn is_user(event: &Value, text: &str) -> bool {
    event["type"] == "message"
        && event["message"]["role"] == "user"
        && event["message"]["content"].to_string().contains(text)
}

/// Wait, in short steps, for `ready` — a teammate's turn runs on its own task.
async fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..200 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn the_row_registers_the_nine_tools_and_refuses_a_bad_config() {
    let home = Scratch::new("tools-home");
    let work = Scratch::new("tools-work");
    let booted = boot(&home.0, &work.0, json!([]));
    start(&booted);
    let names: Vec<String> = booted
        .runtime
        .tools
        .describe()
        .into_iter()
        .map(|spec| spec.name)
        .collect();
    for name in TEAM_TOOL_NAMES {
        assert!(
            names.iter().any(|known| known == name),
            "{name} is registered"
        );
    }
    let refused = start_row(TeamRow {
        config: &json!({ "maxMembers": "eight" }),
        sessions: Arc::clone(&booted.sessions),
        models: Arc::clone(&booted.models),
        runtime: booted.runtime.clone(),
        emit_changed: None,
        warn: None,
    });
    assert!(
        refused.is_err_and(|error| error.starts_with("team: ")),
        "a malformed row is the boot's sentence, not a panic"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_lead_turn_runs_the_check_teams_script_through_the_composed_row() {
    let home = Scratch::new("turn-home");
    let work = Scratch::new("turn-work");
    // check-teams.mjs's first script, step for step.
    let steps = json!([
        { "toolCall": { "name": "spawn_teammate", "arguments": { "name": "alpha", "description": "the teammate", "prompt": "write the thing" } } },
        { "toolCall": { "name": "team_task_create", "arguments": { "subject": "write the thing", "write_scopes": ["src/team"] } } },
        { "toolCall": { "name": "team_task_update", "arguments": { "task_id": "task-1", "revision": 1, "action": "claim" } } },
        { "toolCall": { "name": "team_task_update", "arguments": { "task_id": "task-1", "revision": 2, "action": "complete" } } },
        { "toolCall": { "name": "send_message", "arguments": { "target": "alpha", "message": "the board is clear" } } },
        { "toolCall": { "name": "list_agents", "arguments": {} } },
        { "text": "team finished the work" },
        { "purpose": "team", "text": "alpha reports: work complete" },
    ]);
    let booted = boot(&home.0, &work.0, steps);
    let plugin = start(&booted);
    let lead = booted
        .sessions
        .store()
        .create(CreateOptions {
            cwd: Some(work.0.to_string_lossy().into_owned()),
            endpoint: Some("scripted".to_owned()),
            model: Some("scripted".to_owned()),
            ..CreateOptions::default()
        })
        .expect("the Lead session");

    let result = heddle_agent::run_turn(
        &booted.runtime,
        RunTurnOptions::new(lead.clone(), "scripted", "Lead: do the team work"),
    )
    .await
    .expect("the Lead turn ran");
    assert!(
        result.text.contains("team finished the work"),
        "the Lead answered last: {}",
        result.text
    );

    let lead_events = events(&booted, &lead.id);
    let member = lead_events
        .iter()
        .find(|event| event["type"] == "team/member")
        .expect("a member is journaled");
    let child_id = member["member"]["id"]
        .as_str()
        .expect("the member names its session")
        .to_owned();
    let meta = booted
        .sessions
        .store()
        .meta(&child_id)
        .expect("the teammate's meta");
    assert_eq!(meta.team_id(), Some(lead.id.as_str()));
    assert_eq!(meta.parent_session(), Some(lead.id.as_str()));
    assert_eq!(meta.delegation_depth(), Some(1));
    assert_eq!(
        serde_json::to_value(meta.origin()).expect("an origin serializes"),
        json!("subagent")
    );

    let count = |kind: &str| {
        lead_events
            .iter()
            .filter(|event| event["type"] == kind)
            .count()
    };
    assert!(count("team/member") >= 2, "provisioning then active");
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
    let claim = lead_events
        .iter()
        .filter(|event| event["type"] == "team/task")
        .nth(1)
        .expect("the claim");
    assert_eq!(
        claim["task"]["ownerId"],
        json!(lead.id),
        "the Lead claimed it"
    );
    assert_eq!(count("team/message/queued"), 1);
    assert_eq!(count("team/message/delivered"), 1);
    assert!(
        lead_events
            .iter()
            .any(|event| is_user(event, "Lead: do the team work"))
    );

    // The teammate's own turn runs on its own task; its answer arrives shortly after the Lead's.
    wait_for("the teammate's answer", || {
        events(&booted, &child_id)
            .iter()
            .any(|event| event.to_string().contains("alpha reports"))
    })
    .await;
    let child_events = events(&booted, &child_id);
    assert!(
        child_events
            .iter()
            .any(|event| is_user(event, "write the thing")),
        "the spawn prompt"
    );
    assert!(
        child_events
            .iter()
            .any(|event| is_user(event, "the board is clear")),
        "the mailed message"
    );
    assert!(
        child_events
            .iter()
            .any(|event| event.to_string().contains("team-message")),
        "the mailed message carries its team-message source"
    );

    // What GET /api/team answers through heddle-server's port.
    let view = ServerTeam(Arc::clone(&plugin.service))
        .view(&lead.id)
        .expect("the team view folds");
    let roster: Vec<(String, String)> = view
        .members
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
    assert_eq!(view.tasks[0]["status"], "completed");

    // Restart on the same store: the boot edge recovers the team and the view survives.
    let restarted = boot(&home.0, &work.0, json!([]));
    let plugin = start(&restarted);
    let note = web_start_note(&plugin.service).await;
    assert!(
        note.as_deref()
            .is_some_and(|note| note.starts_with("recovered 1 team(s)")),
        "{note:?}"
    );
    let view = ServerTeam(Arc::clone(&plugin.service))
        .view(&lead.id)
        .expect("the team view folds after the restart");
    assert_eq!(
        view.members.as_array().map(Vec::len),
        Some(2),
        "the roster survived the restart"
    );
    assert_eq!(
        view.tasks[0]["status"], "completed",
        "the board survived the restart"
    );
}

#[test]
fn a_refused_fold_reaches_the_server_as_its_500_with_the_code() {
    let home = Scratch::new("fold-home");
    let work = Scratch::new("fold-work");
    let booted = boot(&home.0, &work.0, json!([]));
    let plugin = start(&booted);
    let lead = booted
        .sessions
        .store()
        .create(CreateOptions {
            cwd: Some(work.0.to_string_lossy().into_owned()),
            ..CreateOptions::default()
        })
        .expect("a session");
    booted
        .sessions
        .store()
        .append(
            &lead,
            heddle_session::NewEvent::try_from(json!({
                "type": "team/member", "version": 2, "teamId": lead.id,
                "member": { "id": "session-ghost", "name": "ghost", "description": "x", "context": "fresh", "phase": "active" }
            }))
            .expect("an event"),
            heddle_session::AppendOptions::default(),
        )
        .expect("the corrupt member is journaled");
    let refused = ServerTeam(Arc::clone(&plugin.service))
        .view(&lead.id)
        .expect_err("the fold refuses the log");
    assert_eq!(refused.code.as_deref(), Some("TEAM_MEMBER_PHASE"));
}

/// A `TeamAgent` shaped like the binary's first team row (`adapters.rs` at main `59f0b94`): it runs
/// `heddle_agent::run_turn` *inside* the future it returns, so the member's prompt is written only when the spawned
/// turn first runs, after `begin_turn` has returned.
struct DeferredAgent {
    runtime: AgentRuntime,
    store: Arc<heddle_session::SessionStore>,
}

impl heddle_team::plugin::TeamAgent for DeferredAgent {
    fn begin_turn(
        &self,
        request: heddle_team::plugin::TeamTurnRequest,
    ) -> Result<heddle_team::ports::TurnFuture, String> {
        let handle = self
            .store
            .open(&request.session)
            .ok_or_else(|| format!("no session {}", request.session))?;
        let mut options = RunTurnOptions::new(handle, request.endpoint, request.prompt);
        options.model = request.model;
        options.purpose = Some(request.purpose.to_owned());
        options.source = Some(request.source);
        let runtime = self.runtime.clone();
        Ok(Box::pin(async move {
            heddle_agent::run_turn(&runtime, options)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        }))
    }

    fn default_endpoint(&self) -> Option<String> {
        Some("scripted".to_owned())
    }
}

/// **The seam's ordering contract, pinned.** The team proves a delivery by reading the target's own log the moment
/// `begin_turn` returns, as the TypeScript build can because its `runTurn` appends the prompt before its first
/// await. A runner that defers the prompt into its future therefore leaves every message `queued`: the message
/// does reach the member's log once the turn runs, but the journal never learns it, so `team/message/delivered` is
/// never written — check-teams counts exactly one, and boot recovery would report `0 delivered`.
/// `compose::start_row` builds its agent on `heddle_agent::begin_turn`, which writes the prompt and registers the
/// turn before returning; `a_real_lead_turn_runs_the_check_teams_script_through_the_composed_row` delivers.
#[tokio::test]
async fn a_runner_that_defers_the_prompt_into_its_future_cannot_prove_delivery() {
    let home = Scratch::new("deferred-home");
    let work = Scratch::new("deferred-work");
    let steps = json!([
        { "purpose": "team", "text": "alpha is ready" },
        { "purpose": "team", "text": "alpha read the mail" },
    ]);
    let booted = boot(&home.0, &work.0, steps);
    let store = Arc::clone(booted.sessions.store());
    let plugin = heddle_team::TeamPlugin::install(heddle_team::TeamPluginDeps {
        store: Arc::new(heddle_team::compose::SessionTeamStore::new(Arc::clone(
            &store,
        ))),
        agent: Arc::new(DeferredAgent {
            runtime: (*booted.runtime).clone(),
            store: Arc::clone(&store),
        }),
        live: None,
        config: heddle_team::TeamConfig::default(),
        emit_changed: None,
        warn: None,
    });
    let lead = store
        .create(CreateOptions {
            cwd: Some(work.0.to_string_lossy().into_owned()),
            endpoint: Some("scripted".to_owned()),
            ..CreateOptions::default()
        })
        .expect("the Lead session");
    let spawned = plugin
        .tools
        .call(
            "spawn_teammate",
            &json!({ "name": "alpha", "description": "the teammate", "prompt": "get ready" }),
            Some(&lead.id),
        )
        .await;
    assert!(spawned.error.is_none(), "{:?}", spawned.error);
    let child_id = spawned.data.as_ref().expect("the spawn reports its member")["id"]
        .as_str()
        .expect("the member's id")
        .to_owned();
    // Let alpha's first turn run and finish, so the mail finds it idle.
    wait_for("alpha's first answer", || {
        events(&booted, &child_id)
            .iter()
            .any(|event| event.to_string().contains("alpha is ready"))
    })
    .await;

    let sent = plugin
        .tools
        .call(
            "send_message",
            &json!({ "target": "alpha", "message": "the board is clear" }),
            Some(&lead.id),
        )
        .await;
    assert_eq!(
        sent.data.as_ref().map(|data| data["status"].clone()),
        Some(json!("queued")),
        "the prompt was not yet in alpha's log when begin_turn returned"
    );
    let delivered = |booted: &Booted| {
        events(booted, &lead.id)
            .iter()
            .filter(|event| event["type"] == "team/message/delivered")
            .count()
    };
    assert_eq!(delivered(&booted), 0);
    // The deferred turn does write the message once it runs; the journal still never records the delivery.
    wait_for("the mail in alpha's log", || {
        events(&booted, &child_id)
            .iter()
            .any(|event| is_user(event, "the board is clear"))
    })
    .await;
    assert_eq!(
        delivered(&booted),
        0,
        "nothing journals the delivery after the fact"
    );
}

/// The team holds the runtime weakly (its registry holds the team's tools, so a strong reference would be a cycle).
/// Once the run that owned it drops the runtime, a new member's first turn is refused rather than started on a
/// runtime nobody owns. As in the TypeScript build, a first turn is fire-and-forget: the spawn still answers, and
/// the refusal lands as `turn/failed` in the member's own log.
#[tokio::test]
async fn a_member_turn_after_the_run_has_ended_is_refused_not_leaked() {
    let home = Scratch::new("ended-home");
    let work = Scratch::new("ended-work");
    let booted = boot(&home.0, &work.0, json!([]));
    let plugin = start(&booted);
    let lead = booted
        .sessions
        .store()
        .create(CreateOptions {
            cwd: Some(work.0.to_string_lossy().into_owned()),
            endpoint: Some("scripted".to_owned()),
            ..CreateOptions::default()
        })
        .expect("the Lead session");
    let Booted {
        sessions, runtime, ..
    } = booted;
    let weak = Arc::downgrade(&runtime);
    drop(runtime);
    assert!(
        weak.upgrade().is_none(),
        "nothing in the team keeps the runtime alive"
    );
    let outcome = plugin
        .tools
        .call(
            "spawn_teammate",
            &json!({ "name": "alpha", "description": "the teammate", "prompt": "go" }),
            Some(&lead.id),
        )
        .await;
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    let child_id = outcome.data.as_ref().expect("the spawn reports its member")["id"]
        .as_str()
        .expect("the member's id")
        .to_owned();
    let handle = sessions
        .store()
        .open(&child_id)
        .expect("the teammate's session");
    let refused = sessions
        .store()
        .read(&handle)
        .expect("the teammate's log")
        .iter()
        .map(|event| event.to_value())
        .any(|event| {
            event["type"] == "turn/failed"
                && event["reason"]
                    .as_str()
                    .is_some_and(|reason| reason.contains("the run that owned this team has ended"))
        });
    assert!(
        refused,
        "the refused first turn is recorded in the teammate's own log"
    );
}

/// Mail to a teammate whose turn has finished takes the idle path: the team begins a new turn, whose prompt *is*
/// the message, and journals the delivery before `send` returns. (Mail to a teammate mid-turn takes the steer
/// path instead, appended to its log for the loop to notice; check-teams can take either, depending on how fast the
/// teammate's first turn ends, so each path needs its own proof.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mail_to_an_idle_teammate_is_delivered_by_a_new_turn_before_send_returns() {
    let home = Scratch::new("idle-home");
    let work = Scratch::new("idle-work");
    // The scripted endpoint hands out a purpose's steps by round within a turn, so every member turn answers
    // with the first `team` step.
    let steps = json!([{ "purpose": "team", "text": "alpha is ready" }]);
    let booted = boot(&home.0, &work.0, steps);
    let plugin = start(&booted);
    let lead = booted
        .sessions
        .store()
        .create(CreateOptions {
            cwd: Some(work.0.to_string_lossy().into_owned()),
            endpoint: Some("scripted".to_owned()),
            ..CreateOptions::default()
        })
        .expect("the Lead session");
    let spawned = plugin
        .tools
        .call(
            "spawn_teammate",
            &json!({ "name": "alpha", "description": "the teammate", "prompt": "get ready" }),
            Some(&lead.id),
        )
        .await;
    assert!(spawned.error.is_none(), "{:?}", spawned.error);
    let child_id = spawned.data.as_ref().expect("the spawn reports its member")["id"]
        .as_str()
        .expect("the member's id")
        .to_owned();
    let turns = booted
        .runtime
        .turns
        .clone()
        .expect("the live-turn registry");
    wait_for("alpha's first turn to finish", || {
        !turns.is_running(&child_id)
            && events(&booted, &child_id)
                .iter()
                .any(|event| event["type"] == "turn/completed")
    })
    .await;

    let sent = plugin
        .tools
        .call(
            "send_message",
            &json!({ "target": "alpha", "message": "the board is clear" }),
            Some(&lead.id),
        )
        .await;
    assert_eq!(
        sent.data.as_ref().map(|data| data["status"].clone()),
        Some(json!("accepted")),
        "{:?}",
        sent
    );
    let delivered = events(&booted, &lead.id)
        .iter()
        .filter(|event| event["type"] == "team/message/delivered")
        .count();
    assert_eq!(delivered, 1, "journaled before send returned");
    // The mail began alpha's second turn, which runs to completion on its own task.
    wait_for("the turn the mail began to finish", || {
        let events = events(&booted, &child_id);
        events
            .iter()
            .any(|event| is_user(event, "the board is clear"))
            && events
                .iter()
                .filter(|event| event["type"] == "turn/completed")
                .count()
                == 2
    })
    .await;
}
