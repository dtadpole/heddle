//! The agent runtime: `heddle-agent`'s ports over the booted crates.
//!
//! `heddle-agent` runs a turn through four narrow ports of its own — the model, the session, the context
//! and the turn's hook points — and `heddle-tools`'s registry. It depends on none of the crates behind
//! them, so the composition root implements each port over the service the boot registered:
//!
//! `heddle-agent` ships the adapter for each (`heddle_agent::adapters`), behind its own seam, so the
//! binary only hands each one the service the boot registered:
//!
//! | Port | Adapter | Over |
//! |---|---|---|
//! | [`heddle_agent::ModelPort`] | `adapters::LlmModel` | `heddle-llm`'s `ModelService` |
//! | [`heddle_agent::SessionPort`] | `adapters::Sessions` | `heddle-session`'s `SessionService` |
//! | [`heddle_agent::ContextPort`] | `adapters::Context` | `heddle-context`'s service on the session store |
//! | [`heddle_agent::TurnHooks`] | `BusHooks`, then `adapters::ContextRecovery` | the run's bus, then the overflow recovery |

use std::sync::{Arc, OnceLock};

use heddle_agent::AgentRuntime;

use crate::adapters::Context;
use crate::services::Services;

/// The process's one async runtime: an outside component's stdio tasks, a turn and the server all run on
/// it, so a child process started during the boot keeps its reader after the boot returns.
pub fn tokio() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("the process can start its async runtime")
    })
}

/// The one runtime every agent of this run shares — the turn, a subagent, a goal round, a teammate — so a
/// delegated child runs with the same tools and the same session store as its parent. Built the first
/// time a row or the turn asks for it, then kept under `agent-runtime`.
pub fn shared_runtime(services: &mut Services) -> Result<Arc<AgentRuntime>, String> {
    if let Some(runtime) = services.get::<Arc<AgentRuntime>>("agent-runtime") {
        return Ok(runtime);
    }
    let runtime = Arc::new(agent_runtime(services)?);
    services.provide("agent-runtime", Arc::clone(&runtime));
    Ok(runtime)
}

/// The turn's hook points: the bus's listeners (`agent/pre-step`, and `agent/request-error` from an
/// outside component), then the context service's overflow recovery on `agent/request-error`, as the
/// TypeScript context plugin attaches it — one forced reduction and one retry on a refused window.
fn turn_hooks(services: &Services, context: &Arc<Context>) -> Arc<dyn heddle_agent::TurnHooks> {
    let mut hooks: Vec<Arc<dyn heddle_agent::TurnHooks>> = Vec::new();
    if let Some(bus) = crate::adapters::bus_hooks(services) {
        hooks.push(Arc::new(bus));
    }
    hooks.push(Arc::new(
        heddle_agent::adapters::ContextRecovery::over_session_handles(Arc::clone(context)),
    ));
    Arc::new(heddle_agent::ChainedTurnHooks::new(hooks))
}

/// The runtime a turn runs on, from what the boot provided; the sentence naming the first missing
/// service otherwise, as the TypeScript build's `ctx.<service>` lookups would fail.
pub fn agent_runtime(services: &Services) -> Result<AgentRuntime, String> {
    let models = services
        .get::<Arc<heddle_llm::ModelService>>("model")
        .ok_or("this profile does not load the model plugin")?;
    let sessions = services
        .get::<Arc<heddle_session::SessionService>>("session")
        .ok_or("this profile does not load the session plugin")?;
    let context = services
        .get::<Arc<Context>>("context")
        .ok_or("this profile does not load the context plugin")?;
    let tools = services
        .get::<Arc<heddle_tools::ToolRegistry>>("tools")
        .ok_or("this profile does not load the tools plugin")?;
    let hooks = turn_hooks(services, &context);
    Ok(AgentRuntime {
        model: Arc::new(heddle_agent::adapters::LlmModel::new(models)),
        session: Arc::new(heddle_agent::adapters::Sessions::new(sessions)),
        context: Arc::new(heddle_agent::adapters::Context::over_session_handles(
            context,
        )),
        tools,
        hooks,
        turns: services.get::<heddle_agent::TurnRegistry>("turns"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtins::{BuiltinCatalog, Catalog, resolve_component};
    use serde_json::{Value, json};
    use std::path::PathBuf;

    fn scratch(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "heddle-runtime-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        std::fs::canonicalize(&dir).expect("canonical")
    }

    /// The rows a turn needs, started through the binary's own catalog, with a scripted endpoint.
    fn booted(home: &std::path::Path, steps: Value) -> Services {
        let script = home.join("script.json");
        std::fs::write(&script, json!({ "steps": steps }).to_string()).expect("the script");
        let env = heddle_config::Env::from_pairs([
            ("HEDDLE_HOME", home.to_string_lossy().into_owned()),
            ("HOME", home.to_string_lossy().into_owned()),
        ]);
        let catalog = BuiltinCatalog::new(env, home.to_path_buf());
        let mut services = Services::new();
        let rows = [
            (
                "model",
                json!({
                    "readLocalConfig": false,
                    "default": "double",
                    "endpoints": [{
                        "name": "double",
                        "kind": "scripted",
                        "baseUrl": script,
                        "model": "scripted",
                    }],
                }),
            ),
            ("session", json!({ "root": home.join("sessions") })),
            ("sandbox", json!({ "workspaceRoot": home })),
            ("approvals", json!({})),
            ("tools", json!({})),
            ("context", json!({})),
            ("turns", json!({})),
        ];
        for (bare, config) in rows {
            let reference = resolve_component(&heddle_config::ComponentName::Bare(bare.to_owned()));
            catalog
                .component(&reference)
                .unwrap_or_else(|| panic!("{bare} has an adapter"))
                .start(&config, &mut services)
                .unwrap_or_else(|error| panic!("{bare} starts: {error}"));
        }
        services
    }

    #[test]
    fn a_runtime_needs_the_four_services_a_turn_reads() {
        let error = agent_runtime(&Services::new())
            .err()
            .expect("nothing is booted");
        assert_eq!(error, "this profile does not load the model plugin");
    }

    #[test]
    fn a_turn_runs_on_the_composed_runtime_and_lands_in_the_session_log() {
        let home = scratch("turn");
        let services = booted(&home, json!([{ "text": "hello from the double" }]));
        let runtime = agent_runtime(&services).expect("the runtime composes");
        let sessions = services
            .get::<Arc<heddle_session::SessionService>>("session")
            .expect("the session service");
        let handle = sessions
            .open_at(
                &home.to_string_lossy(),
                heddle_session::OpenAtOptions {
                    endpoint: Some("double".to_owned()),
                    ..heddle_session::OpenAtOptions::default()
                },
            )
            .expect("the folder's session");
        let result = tokio::runtime::Runtime::new()
            .expect("a runtime")
            .block_on(heddle_agent::run_turn(
                &runtime,
                heddle_agent::RunTurnOptions::new(handle.clone(), "double", "say something"),
            ))
            .expect("the turn completes");
        assert_eq!(result.text, "hello from the double");
        assert_eq!(result.rounds, 1);
        let kinds: Vec<String> = sessions
            .events(&handle)
            .expect("the log reads")
            .iter()
            .map(|event| event.kind.clone())
            .collect();
        for kind in [
            "message",
            "model/request",
            "assistant/completed",
            "turn/completed",
        ] {
            assert!(
                kinds.iter().any(|written| written == kind),
                "{kind} in {kinds:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
