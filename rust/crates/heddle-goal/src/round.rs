//! The driver's rounds over `heddle-agent`'s real turn — the `run` the goal-driver plugin hands its driver
//! (`src/plugins/goal-driver.ts`).
//!
//! The oracle runs each round as an ordinary turn on the session's own endpoint and model (the default
//! endpoint when the session recorded none), with the round's `source` attached to the prompt, so the turn
//! writes the goal-sourced user message the fold counts as an admitted round:
//!
//! ```text
//! const meta = ctx.session.list().find((one) => one.id === handle.id)
//! const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
//! if (endpoint === undefined) throw new Error('goal round driver: no endpoint is configured')
//! return await runTurn(ctx, { session: handle, endpoint, prompt, source, ...(meta?.model ? { model } : {}) })
//! ```
//!
//! A boot builds one [`AgentRoundRunner`] from the agent runtime it already composes and the session store, and
//! hands it to [`GoalDriver::new`](crate::GoalDriver::new). The binary keeps an equivalent adapter of its own.

use std::sync::Arc;

use futures::future::BoxFuture;
use heddle_agent::{AgentRuntime, RunTurnOptions, run_turn};
use heddle_session::{SessionMeta, SessionStore};
use serde_json::Value;

use crate::driver::{GoalRoundSource, RoundRunner};

/// The sentence a round fails with when neither the session nor the deployment names an endpoint.
pub const NO_ENDPOINT_SENTENCE: &str = "goal round driver: no endpoint is configured";

/// The endpoint and model one round runs on: the session's recorded ones, else the default endpoint and no
/// model override.
pub fn round_target(
    meta: Option<&SessionMeta>,
    default_endpoint: Option<String>,
) -> Result<(String, Option<String>), String> {
    let recorded = |key: &str| {
        meta.and_then(|meta| meta.as_map().get(key))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let endpoint = recorded("endpoint")
        .or(default_endpoint)
        .ok_or_else(|| NO_ENDPOINT_SENTENCE.to_owned())?;
    Ok((endpoint, recorded("model")))
}

/// DSH's `waitForChildren` (dsh-subagent lib/index.js:1296-1330): join every descendant of `session` that is working,
/// leave the idle ones (a parked teammate) alone, and look again until none works; answers whether anything was
/// waited for. A descendant is a session whose subagent parent chain (`parent_of`, which answers only for a
/// subagent's record, never a fork's) reaches `session`.
pub async fn wait_for_descendants(
    turns: &heddle_agent::TurnRegistry,
    parent_of: &(dyn Fn(&str) -> Option<String> + Send + Sync),
    session: &str,
) -> bool {
    let descends = |id: &str| {
        let mut current = id.to_owned();
        for _ in 0..32 {
            match parent_of(&current) {
                Some(parent) if parent == session => return true,
                Some(parent) => current = parent,
                None => return false,
            }
        }
        false
    };
    let mut observed = false;
    loop {
        let progressing: Vec<String> = turns
            .running()
            .into_iter()
            .filter(|id| id != session && descends(id))
            .collect();
        if progressing.is_empty() {
            return observed;
        }
        observed = true;
        for id in &progressing {
            turns.when_idle(id).await;
        }
    }
}

/// The subagent parent a session's record names: `parentSession` when its `origin` is `subagent`; a fork's
/// `parentSession` is not followed.
pub fn subagent_parent(meta: Option<&SessionMeta>) -> Option<String> {
    let map = meta?.as_map();
    if map.get("origin").and_then(Value::as_str) != Some("subagent") {
        return None;
    }
    map.get("parentSession")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// A [`RoundRunner`] that answers each round with one real turn.
pub struct AgentRoundRunner {
    runtime: AgentRuntime,
    store: Arc<SessionStore>,
}

impl AgentRoundRunner {
    /// Rounds over `runtime`, opening sessions in `store` — the store the runtime's session port writes to.
    pub fn new(runtime: AgentRuntime, store: Arc<SessionStore>) -> Self {
        Self { runtime, store }
    }
}

impl RoundRunner for AgentRoundRunner {
    fn run(
        &self,
        session: &str,
        prompt: String,
        source: GoalRoundSource,
    ) -> BoxFuture<'static, Result<(), String>> {
        let Some(handle) = self.store.open(session) else {
            let message = format!("no session {session}");
            return Box::pin(async move { Err(message) });
        };
        let target = round_target(
            self.store.meta(session).as_ref(),
            self.runtime.model.default_endpoint(),
        );
        let (endpoint, model) = match target {
            Ok(target) => target,
            Err(message) => return Box::pin(async move { Err(message) }),
        };
        let source = match serde_json::to_value(&source) {
            Ok(source) => source,
            Err(error) => {
                let message = format!("a round's source does not serialize: {error}");
                return Box::pin(async move { Err(message) });
            }
        };
        let mut options = RunTurnOptions::new(handle, endpoint, prompt);
        options.source = Some(source);
        options.model = model;
        let runtime = self.runtime.clone();
        Box::pin(async move {
            run_turn(&runtime, options)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }

    fn wait_for_children(&self, session: &str) -> BoxFuture<'static, bool> {
        let Some(turns) = self.runtime.turns.clone() else {
            return Box::pin(async { false });
        };
        let store = Arc::clone(&self.store);
        let session = session.to_owned();
        Box::pin(async move {
            let parent_of = move |id: &str| subagent_parent(store.meta(id).as_ref());
            wait_for_descendants(&turns, &parent_of, &session).await
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use futures::future::BoxFuture;
    use heddle_agent::{ContextPort, LlmModel, PortError};
    use heddle_config::Env;
    use heddle_session::{CreateOptions, SessionConfig, SessionHandle, SessionService};
    use serde_json::json;

    use super::*;

    /// Inventory A9: the wait joins a working subagent descendant (a grandchild included), ignores a fork and the
    /// session itself, and says whether it waited.
    #[tokio::test]
    async fn the_descendant_wait_joins_working_subagents_and_not_a_fork() {
        let turns = heddle_agent::TurnRegistry::new();
        let parents: std::collections::HashMap<&str, &str> =
            [("child", "lead"), ("grandchild", "child")]
                .into_iter()
                .collect();
        let parent_of = move |id: &str| parents.get(id).map(|parent| (*parent).to_owned());
        assert!(
            !wait_for_descendants(&turns, &parent_of, "lead").await,
            "nothing works: no wait"
        );
        let own = turns.begin("lead", None);
        let fork = turns.begin("fork", None);
        assert!(
            !wait_for_descendants(&turns, &parent_of, "lead").await,
            "the session's own turn and a fork's are not its descendants"
        );
        let grandchild = turns.begin("grandchild", None);
        let waiter = tokio::spawn({
            let turns = turns.clone();
            let parent_of = parent_of.clone();
            async move { wait_for_descendants(&turns, &parent_of, "lead").await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!waiter.is_finished(), "a working grandchild holds the wait");
        grandchild.settle();
        assert!(waiter.await.unwrap(), "and the wait reports that it waited");
        own.settle();
        fork.settle();
    }

    #[test]
    fn only_a_subagent_record_names_its_parent() {
        let meta = |value: serde_json::Value| SessionMeta::from_value(value).unwrap();
        let child = meta(json!({"id": "c", "parentSession": "p", "origin": "subagent"}));
        let fork = meta(json!({"id": "f", "parentSession": "p"}));
        assert_eq!(subagent_parent(Some(&child)).as_deref(), Some("p"));
        assert_eq!(
            subagent_parent(Some(&fork)),
            None,
            "a fork is a session of its own"
        );
        assert_eq!(subagent_parent(None), None);
    }
    use crate::driver::{GoalDriver, ROUND_LIMIT_CODE};
    use crate::service::{CreateGoal, GoalConfig, GoalPhase, GoalService};

    fn meta(value: Value) -> SessionMeta {
        SessionMeta::from_value(value).unwrap()
    }

    #[test]
    fn a_round_runs_on_the_sessions_endpoint_and_model_else_the_default() {
        let recorded = meta(json!({"id": "s1", "endpoint": "chat", "model": "big"}));
        assert_eq!(
            round_target(Some(&recorded), Some("scripted".into())),
            Ok(("chat".into(), Some("big".into())))
        );
        let bare = meta(json!({"id": "s1"}));
        assert_eq!(
            round_target(Some(&bare), Some("scripted".into())),
            Ok(("scripted".into(), None))
        );
        assert_eq!(
            round_target(None, Some("scripted".into())),
            Ok(("scripted".into(), None))
        );
        assert_eq!(
            round_target(Some(&bare), None),
            Err(NO_ENDPOINT_SENTENCE.to_owned())
        );
    }

    /// The context port, reduced to what one round needs: the request is the round's own prompt.
    struct PromptOnly;

    impl ContextPort for PromptOnly {
        fn record_runtime_context(
            &self,
            _session: &SessionHandle,
            _sections: &[heddle_agent::upstream::RuntimeContextSection],
        ) -> Result<(), PortError> {
            Ok(())
        }

        fn prepare<'a>(
            &'a self,
            _session: &'a SessionHandle,
            _options: heddle_agent::upstream::PrepareOptions,
        ) -> BoxFuture<'a, Result<heddle_agent::upstream::ContextReport, PortError>> {
            Box::pin(async { Ok(report()) })
        }

        fn assemble(
            &self,
            _session: &SessionHandle,
            _options: heddle_agent::upstream::PrepareOptions,
        ) -> Result<heddle_agent::upstream::ContextReport, PortError> {
            Ok(report())
        }
    }

    fn report() -> heddle_agent::upstream::ContextReport {
        heddle_agent::upstream::ContextReport {
            messages: vec![heddle_llm::Message::new(
                heddle_llm::Role::User,
                vec![heddle_llm::ContentPart::Text {
                    text: "continue".into(),
                }],
            )],
            ..Default::default()
        }
    }

    struct Fixture {
        root: PathBuf,
        sessions: Arc<SessionService>,
        runtime: AgentRuntime,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture(label: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "heddle-goal-round-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let script = root.join("scripted.json");
        std::fs::write(&script, r#"{"steps":[{"text":"round work"}]}"#).unwrap();
        let model = Arc::new(
            heddle_llm::ModelService::new(vec![heddle_llm::EndpointConfig {
                name: "scripted".into(),
                kind: heddle_llm::EndpointKind::Scripted,
                base_url: script.display().to_string(),
                model: Some("scripted".into()),
                ..heddle_llm::EndpointConfig::default()
            }])
            .unwrap(),
        );
        let config: SessionConfig =
            serde_json::from_value(json!({"root": root.join("sessions").display().to_string()}))
                .unwrap();
        let sessions = Arc::new(SessionService::new(&config, &Env::default(), None));
        let sandbox_config: heddle_sandbox::SandboxConfig = serde_json::from_value(json!({
            "mode": "workspace-write",
            "workspaceRoot": work.display().to_string(),
            "backend": "none"
        }))
        .unwrap();
        let host = heddle_sandbox::SandboxHost::detect(root.join("home")).unwrap();
        let sandbox = Arc::new(heddle_sandbox::SandboxService::new(&sandbox_config, &host));
        let approvals: heddle_sandbox::ApprovalsConfig =
            serde_json::from_value(json!({"mode": "allow"})).unwrap();
        let gates = heddle_tools::ToolGates {
            approvals: Arc::new(heddle_tools::adapters::SandboxApprovals::new(Arc::new(
                heddle_sandbox::ApprovalService::new(approvals),
            ))),
            sandbox: Arc::new(heddle_tools::adapters::Sandbox::new(sandbox)),
            modes: Arc::new(heddle_tools::DefaultModes),
            hooks: Arc::new(heddle_tools::NoToolHooks),
        };
        let runtime = AgentRuntime {
            model: Arc::new(LlmModel::new(model)),
            session: Arc::new(heddle_agent::adapters::Sessions::new(sessions.clone())),
            context: Arc::new(PromptOnly),
            tools: Arc::new(heddle_tools::ToolRegistry::new(gates)),
            hooks: Arc::new(heddle_agent::NoTurnHooks),
            turns: None,
            presets: None,
        };
        Fixture {
            root,
            sessions,
            runtime,
        }
    }

    fn session(fixture: &Fixture) -> String {
        fixture
            .sessions
            .store()
            .create(CreateOptions {
                cwd: Some(fixture.root.join("work").display().to_string()),
                ..CreateOptions::default()
            })
            .unwrap()
            .id
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_armed_goal_continues_by_itself_round_by_round_and_blocks_at_its_cap() {
        let fixture = fixture("rounds");
        let session = session(&fixture);
        let store = fixture.sessions.store().clone();
        let goals = Arc::new(GoalService::new(store.clone(), GoalConfig::default()));
        let created = goals
            .create(
                &session,
                CreateGoal {
                    objective: "walk two rounds and stop".into(),
                    max_goal_rounds: Some(2.0),
                },
            )
            .unwrap();
        let runner = AgentRoundRunner::new(fixture.runtime.clone(), store.clone());
        let driver = GoalDriver::new(goals.clone(), Arc::new(runner));
        let outcome = driver.advance(&session).await;
        assert_eq!(outcome.rounds, 2, "{outcome:?}");
        assert_eq!(outcome.stopped, "round-limit", "{outcome:?}");
        assert_eq!(outcome.error, None);

        let view = goals.get(&session).unwrap().unwrap();
        assert_eq!(view.goal.phase, GoalPhase::Blocked);
        assert_eq!(
            view.rounds_started, 2,
            "two rounds were admitted, not one and not three"
        );
        assert_eq!(view.goal.blocked_reason.unwrap().code, ROUND_LIMIT_CODE);

        let handle = store.open(&session).unwrap();
        let rounds: Vec<(u64, String)> = store
            .read(&handle)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "message")
            .filter_map(|event| {
                let message = event.get("message")?;
                let source = message.get("source")?;
                (message["role"] == "user" && source["kind"] == "goal").then(|| {
                    (
                        source["round"].as_u64().unwrap(),
                        message["content"][0]["text"]
                            .as_str()
                            .unwrap_or("")
                            .to_owned(),
                    )
                })
            })
            .collect();
        assert_eq!(
            rounds.iter().map(|(round, _)| *round).collect::<Vec<_>>(),
            [1, 2]
        );
        assert!(rounds[0].1.contains("Round: 1/2"), "{:?}", rounds[0].1);
        assert!(rounds[1].1.contains("Round: 2/2"));
        assert!(
            rounds[0]
                .1
                .contains("Objective: \"walk two rounds and stop\"")
        );
        assert!(
            store
                .read(&handle)
                .unwrap()
                .iter()
                .any(|event| event.kind == "turn/completed"),
            "each round was answered by a real turn"
        );
        let _ = created;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_round_without_an_endpoint_fails_with_the_oracles_sentence() {
        let fixture = fixture("no-endpoint");
        let session = session(&fixture);
        let mut runtime = fixture.runtime.clone();
        runtime.model = Arc::new(LlmModel::new(Arc::new(
            heddle_llm::ModelService::new(Vec::new()).unwrap(),
        )));
        let runner = AgentRoundRunner::new(runtime, fixture.sessions.store().clone());
        let source = GoalRoundSource {
            kind: "goal".into(),
            goal_id: "goal-x".into(),
            revision: 1,
            round: 1,
        };
        let error = runner
            .run(&session, "Round: 1/1".into(), source.clone())
            .await
            .unwrap_err();
        assert_eq!(error, NO_ENDPOINT_SENTENCE);
        let error = runner
            .run("session-nope", "x".into(), source)
            .await
            .unwrap_err();
        assert_eq!(error, "no session session-nope");
    }
}
