//! The agent runtime: `heddle-agent`'s ports over the booted crates.
//!
//! `heddle-agent` runs a turn through four narrow ports of its own — the model, the session, the context
//! and the turn's hook points — and `heddle-tools`'s registry. It depends on none of the crates behind
//! them, so the composition root implements each port over the service the boot registered:
//!
//! | Port | Over |
//! |---|---|
//! | [`heddle_agent::ModelPort`] | `heddle-llm`'s `ModelService` |
//! | [`heddle_agent::SessionPort`] | `heddle-session`'s `SessionService` and its store |
//! | [`heddle_agent::ContextPort`] | `heddle-context`'s service over the session store |
//! | [`heddle_agent::TurnHooks`] | none yet: [`heddle_agent::NoTurnHooks`] until `heddle-events`' bus is mounted |
//!
//! Every crate declares the TypeScript message, chunk and request shapes, so a value crosses between two
//! of them by its JSON; nothing here makes a decision of its own.

use std::path::PathBuf;
use std::sync::Arc;

use futures::StreamExt;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use heddle_agent::{AgentRuntime, PortError};
use serde_json::{Map, Value};

use crate::adapters::Context;
use crate::services::Services;

/// One shape to another through their shared serialization.
fn bridge<T: serde::Serialize, U: serde::de::DeserializeOwned>(value: &T) -> Result<U, String> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|error| error.to_string())
}

fn port_error(error: impl std::fmt::Display) -> PortError {
    PortError(error.to_string())
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
    Ok(AgentRuntime {
        model: Arc::new(AgentModels { service: models }),
        session: Arc::new(AgentSessions { service: sessions }),
        context: Arc::new(AgentContext { service: context }),
        tools,
        hooks: Arc::new(heddle_agent::NoTurnHooks),
        turns: services.get::<heddle_agent::TurnRegistry>("turns"),
    })
}

/// The agent's handle for a session the session crate opened.
pub fn agent_handle(handle: &heddle_session::SessionHandle) -> heddle_tools::SessionHandle {
    heddle_tools::SessionHandle {
        id: handle.id.to_string(),
        dir: PathBuf::from(&handle.dir),
        transcript: PathBuf::from(&handle.transcript),
        meta: PathBuf::from(&handle.meta),
    }
}

/// The session crate's handle for one the agent passes.
fn session_handle(handle: &heddle_tools::SessionHandle) -> heddle_session::SessionHandle {
    heddle_session::SessionHandle {
        id: handle.id.clone(),
        dir: handle.dir.to_string_lossy().into_owned(),
        transcript: handle.transcript.to_string_lossy().into_owned(),
        meta: handle.meta.to_string_lossy().into_owned(),
    }
}

/// `ctx.model` as a turn streams from it.
struct AgentModels {
    service: Arc<heddle_llm::ModelService>,
}

impl heddle_agent::ModelPort for AgentModels {
    fn stream(
        &self,
        request: heddle_agent::upstream::GenerateRequest,
        cancel: Option<heddle_tools::CancellationToken>,
    ) -> BoxStream<'static, Result<heddle_agent::upstream::Chunk, heddle_agent::ModelError>> {
        let refused = |message: String| heddle_agent::ModelError {
            code: None,
            message,
        };
        let request: heddle_llm::GenerateRequest = match bridge(&request) {
            Ok(request) => request,
            Err(error) => {
                return futures::stream::once(async move {
                    Err(refused(format!("the request could not be sent: {error}")))
                })
                .boxed();
            }
        };
        let stream = match self.service.stream(request) {
            Ok(stream) => stream,
            Err(error) => {
                let failure = heddle_agent::ModelError {
                    code: Some(error.code.clone()),
                    message: error.message.clone(),
                };
                return futures::stream::once(async move { Err(failure) }).boxed();
            }
        };
        let chunks = stream.map(move |item| match item {
            Ok(chunk) => bridge(&chunk).map_err(|error| heddle_agent::ModelError {
                code: None,
                message: format!("a chunk could not be read: {error}"),
            }),
            Err(error) => Err(heddle_agent::ModelError {
                code: Some(error.code),
                message: error.message,
            }),
        });
        match cancel {
            // A stop aborts the provider connection: the stream ends where the token is cancelled.
            Some(token) => chunks
                .take_until(async move { token.cancelled_owned().await })
                .boxed(),
            None => chunks.boxed(),
        }
    }

    fn default_endpoint(&self) -> Option<String> {
        self.service.default_endpoint(None)
    }
}

/// `ctx.session` and its store, as a turn reads and writes them.
struct AgentSessions {
    service: Arc<heddle_session::SessionService>,
}

impl heddle_agent::SessionPort for AgentSessions {
    fn count(&self, session: &heddle_tools::SessionHandle) -> usize {
        self.service
            .store()
            .count(&session_handle(session))
            .map(|count| count as usize)
            .unwrap_or(0)
    }

    fn user_content(
        &self,
        session: &heddle_tools::SessionHandle,
        content: Vec<heddle_agent::upstream::ContentPart>,
        source: Option<Value>,
    ) -> Result<(), PortError> {
        let content = bridge(&content).map_err(port_error)?;
        self.service
            .user_content(&session_handle(session), content, source)
            .map_err(port_error)
    }

    fn surface(
        &self,
        session: &heddle_tools::SessionHandle,
    ) -> heddle_agent::upstream::SurfaceView {
        match self.service.surface(&session_handle(session)) {
            Ok(surface) => heddle_agent::upstream::SurfaceView {
                nodes: surface.nodes.clone(),
                content_generation: surface.content_generation,
                replace_generation: surface.replace_generation,
            },
            Err(_) => heddle_agent::upstream::SurfaceView::default(),
        }
    }

    fn node_role(
        &self,
        session: &heddle_tools::SessionHandle,
        seq: u64,
    ) -> Option<heddle_agent::upstream::Role> {
        let message = self.service.node(&session_handle(session), seq).ok()??;
        bridge(&message.role).ok()
    }

    fn folder(&self, session: &heddle_tools::SessionHandle) -> Option<PathBuf> {
        self.service
            .folder(&session_handle(session))
            .map(PathBuf::from)
    }

    fn model_request(
        &self,
        session: &heddle_tools::SessionHandle,
        record: &heddle_agent::ModelRequestRecord,
    ) -> Result<(), PortError> {
        let record = heddle_session::ModelRequestRecord {
            endpoint: record.endpoint.clone(),
            model: record.model.clone(),
            reasoning_effort: record.reasoning_effort.clone(),
            messages: record.messages as u64,
            tools: record.tools.clone(),
            estimated_tokens: Some(record.estimated_tokens),
            threshold_tokens: Some(record.threshold_tokens),
            pruned: Some(record.pruned),
            compacted: Some(record.compacted),
            breakdown: Some(heddle_session::ModelRequestBreakdown {
                system: Some(record.breakdown.system),
                tools: Some(record.breakdown.tools),
                messages: Some(record.breakdown.messages),
            }),
            generation: Some(record.generation),
        };
        self.service
            .store()
            .model_request(&session_handle(session), &record)
            .map(|_| ())
            .map_err(port_error)
    }

    fn assistant_chunk(
        &self,
        session: &heddle_tools::SessionHandle,
        chunk: &heddle_agent::upstream::Chunk,
    ) -> Result<(), PortError> {
        let chunk: heddle_llm::Chunk = bridge(chunk).map_err(port_error)?;
        self.service
            .store()
            .assistant_chunk(&session_handle(session), &chunk)
            .map(|_| ())
            .map_err(port_error)
    }

    fn message(
        &self,
        session: &heddle_tools::SessionHandle,
        message: heddle_agent::upstream::Message,
    ) -> Result<(), PortError> {
        let message: heddle_session::RecordedMessage = bridge(&message).map_err(port_error)?;
        self.service
            .store()
            .message(&session_handle(session), message)
            .map(|_| ())
            .map_err(port_error)
    }

    fn append(
        &self,
        session: &heddle_tools::SessionHandle,
        kind: &str,
        fields: Map<String, Value>,
    ) -> Result<(), PortError> {
        self.service
            .store()
            .append(
                &session_handle(session),
                heddle_session::NewEvent {
                    kind: kind.to_owned(),
                    fields,
                },
                heddle_session::AppendOptions::default(),
            )
            .map(|_| ())
            .map_err(port_error)
    }
}

/// `ctx.context` as a turn asks it.
struct AgentContext {
    service: Arc<Context>,
}

impl AgentContext {
    fn report(
        report: heddle_context::ContextReport,
    ) -> Result<heddle_agent::upstream::ContextReport, PortError> {
        Ok(heddle_agent::upstream::ContextReport {
            messages: bridge(&report.messages).map_err(port_error)?,
            estimated_tokens: report.estimated_tokens,
            context_window: report.context_window,
            threshold_tokens: report.threshold_tokens,
            pruned: report.pruned,
            compacted: report.compacted,
            instructions: report
                .instructions
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            breakdown: bridge(&report.breakdown).map_err(port_error)?,
        })
    }
}

impl heddle_agent::ContextPort for AgentContext {
    fn record_runtime_context(
        &self,
        session: &heddle_tools::SessionHandle,
        sections: &[heddle_agent::upstream::RuntimeContextSection],
    ) -> Result<(), PortError> {
        let sections: Vec<heddle_context::RuntimeContextSection> =
            bridge(&sections).map_err(port_error)?;
        self.service
            .record_runtime_context(&session_handle(session), &sections)
            .map_err(port_error)
    }

    fn prepare<'a>(
        &'a self,
        session: &'a heddle_tools::SessionHandle,
        options: heddle_agent::upstream::PrepareOptions,
    ) -> BoxFuture<'a, Result<heddle_agent::upstream::ContextReport, PortError>> {
        Box::pin(async move {
            let tools: Vec<heddle_context::ToolSpec> =
                bridge(&options.tools).map_err(port_error)?;
            let handle = session_handle(session);
            let report = self
                .service
                .prepare(
                    &handle,
                    &heddle_context::PrepareOptions {
                        cwd: &options.cwd,
                        endpoint: &options.endpoint,
                        model: options.model.as_deref(),
                        tools: &tools,
                        system: options.system.as_deref(),
                        summarizer: None,
                        force: false,
                    },
                )
                .await
                .map_err(port_error)?;
            Self::report(report)
        })
    }

    fn assemble(
        &self,
        session: &heddle_tools::SessionHandle,
        options: heddle_agent::upstream::PrepareOptions,
    ) -> Result<heddle_agent::upstream::ContextReport, PortError> {
        let tools: Vec<heddle_context::ToolSpec> = bridge(&options.tools).map_err(port_error)?;
        let report = self
            .service
            .assemble(
                &session_handle(session),
                &heddle_context::AssembleOptions {
                    cwd: &options.cwd,
                    tools: &tools,
                    system: options.system.as_deref(),
                    endpoint: Some(&options.endpoint),
                    model: options.model.as_deref(),
                },
            )
            .map_err(port_error)?;
        Self::report(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtins::{BuiltinCatalog, Catalog, resolve_component};
    use serde_json::json;

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
                heddle_agent::RunTurnOptions::new(agent_handle(&handle), "double", "say something"),
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
