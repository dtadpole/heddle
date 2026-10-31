//! The ports a turn reaches the rest of the harness through.
//!
//! The TypeScript loop narrows what it uses to a `TurnDeps` of four services and reads context and
//! sandbox through `ctx`. The same narrowing is a trait per service here, so the loop is judged with
//! doubles and composed with the real crates by the binary (an adapter per trait lives here once the
//! owner's API lands). The tool registry is not a port: it is `heddle-tools`'s concrete
//! [`ToolRegistry`](heddle_tools::ToolRegistry), whose own gates are ports.
//!
//! | Port | Owner of the real implementation | TypeScript |
//! |---|---|---|
//! | [`ModelPort`] | `heddle-llm` | `ctx.model.stream`, `defaultEndpoint` |
//! | [`SessionPort`] | `heddle-session` | `ctx.session` and `ctx.session.store` |
//! | [`ContextPort`] | `heddle-context` | `ctx.context.prepare`, `assemble`, `recordRuntimeContext` |
//! | [`TurnHooks`] | `heddle-events` | the `agent/pre-step` and `agent/request-error` waterfalls |

use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::upstream::{
    Chunk, ContentPart, ContextBreakdown, ContextReport, GenerateRequest, Message, PrepareOptions,
    Role, RuntimeContextSection, SessionHandle, SurfaceView, ToolSpec,
};

/// A failure from a port that is not the model's: a session write or a context preparation that failed.
/// It ends the turn, as the TypeScript `throw` does.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PortError(pub String);

/// A model call that failed, read **by its code, not by its type** — the contract that survives a plugin
/// boundary in the TypeScript build, and that the overflow recovery keys on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ModelError {
    /// The stable failure code, e.g. the context-window-exceeded code; `None` for an uncoded failure, which
    /// is never retried.
    pub code: Option<String>,
    /// The provider's sentence.
    pub message: String,
}

impl From<heddle_llm::ModelError> for ModelError {
    /// The model service's failure at the port: its code (always present there; empty reads as uncoded) and its
    /// sentence. `heddle_llm::ModelError` carries a boxed source and is not `Clone`, which [`TurnError`]
    /// (crate::TurnError) must be, so the loop keeps the two facts it branches on and reports.
    fn from(error: heddle_llm::ModelError) -> Self {
        let code = (!error.code.is_empty()).then(|| error.code.clone());
        Self {
            code,
            message: error.message.clone(),
        }
    }
}

/// The model service: one streaming call.
pub trait ModelPort: Send + Sync {
    /// Stream one call's chunks. The stream ends after `done`, or with an error item; `cancel` aborts the
    /// provider connection.
    fn stream(
        &self,
        request: GenerateRequest,
        cancel: Option<CancellationToken>,
    ) -> BoxStream<'static, Result<Chunk, ModelError>>;

    /// The request [`ModelPort::stream`] would send, after the service's `model/request` waterfall.
    ///
    /// The loop records this, not the request it built, so a step a selection policy moved to the session's
    /// current model is logged under that model (issue #14). A port with no waterfall sends what it is given.
    fn resolve(&self, request: GenerateRequest) -> Result<GenerateRequest, ModelError> {
        Ok(request)
    }

    /// Stream a request [`ModelPort::resolve`] already answered, without running the waterfall again, so a call runs
    /// its request hooks exactly once and sends what was recorded. A port with no waterfall streams it as given.
    fn stream_resolved(
        &self,
        request: GenerateRequest,
        cancel: Option<CancellationToken>,
    ) -> BoxStream<'static, Result<Chunk, ModelError>> {
        self.stream(request, cancel)
    }

    /// The endpoint a session with none recorded runs on.
    fn default_endpoint(&self) -> Option<String>;
}

/// The `model/request` record, written before each model call. Field order and spelling are the
/// TypeScript build's.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestRecord {
    /// The endpoint.
    pub endpoint: String,
    /// The model, when the turn named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The reasoning level, when the turn named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// How many messages the request carries.
    pub messages: usize,
    /// The names of the tools it carries.
    pub tools: Vec<String>,
    /// Its estimated size.
    pub estimated_tokens: u64,
    /// The reduction trigger.
    pub threshold_tokens: u64,
    /// Tool results rewritten for this request.
    pub pruned: u64,
    /// Whether a summary landed for it.
    pub compacted: bool,
    /// The size split.
    pub breakdown: ContextBreakdown,
    /// The surface's content generation when the request was built.
    pub generation: u64,
}

/// The session service and its store, narrowed to what a turn reads and writes.
///
/// Every write is on disk before the next step starts, so a killed run reads as a partial turn.
pub trait SessionPort: Send + Sync {
    /// How many events the session's log holds.
    fn count(&self, session: &SessionHandle) -> usize;

    /// Record the user's message (text plus attachments), with who wrote it when it was not a person.
    fn user_content(
        &self,
        session: &SessionHandle,
        content: Vec<ContentPart>,
        source: Option<serde_json::Value>,
    ) -> Result<(), PortError>;

    /// The session's surface: its positions and generations.
    fn surface(&self, session: &SessionHandle) -> SurfaceView;

    /// The role of the message at one surface position, if it is a message.
    fn node_role(&self, session: &SessionHandle, seq: u64) -> Option<Role>;

    /// The conversation's own folder, where instruction files are read; `None` falls back to the workspace.
    fn folder(&self, session: &SessionHandle) -> Option<PathBuf>;

    /// Write a `model/request` record.
    fn model_request(
        &self,
        session: &SessionHandle,
        record: &ModelRequestRecord,
    ) -> Result<(), PortError>;

    /// Write one streamed chunk as `assistant/chunk`, as it arrives.
    fn assistant_chunk(&self, session: &SessionHandle, chunk: &Chunk) -> Result<(), PortError>;

    /// Write one message (the loop writes `tool` messages).
    fn message(&self, session: &SessionHandle, message: Message) -> Result<(), PortError>;

    /// Write an event of the loop's own (`turn/retry`, `assistant/completed`, `turn/completed`): `fields`
    /// follow `type`, in the order given.
    fn append(
        &self,
        session: &SessionHandle,
        kind: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), PortError>;

    /// Write what waits in the session's next-step inbox into the conversation, at a step boundary, and
    /// answer how many messages were claimed (`heddle_session::inbox`, DSH's `ReactLoopInbox.claim`).
    ///
    /// A steer is queued there rather than written, so it reaches the conversation after the result of the
    /// tool call it arrived during. A session with no inbox claims nothing, which is the default.
    fn claim_pending_input(&self, _session: &SessionHandle) -> Result<usize, PortError> {
        Ok(0)
    }

    /// Whether a message waits in the session's next-step inbox. The loop asks before it ends a turn.
    fn has_pending_input(&self, _session: &SessionHandle) -> bool {
        false
    }

    /// A turn began: the session accepts steers until it ends (#31's steer gate). A session with no inbox has
    /// no gate, which is the default.
    fn open_steering(&self, _session: &SessionHandle) {}

    /// The loop's end-of-turn question: whether a message waits; when none does, the steer gate closes in the
    /// same critical section, so no steer is accepted between this decision and the turn's end.
    fn has_pending_input_or_close(&self, session: &SessionHandle) -> bool {
        self.has_pending_input(session)
    }

    /// The turn ended, whichever way: a steer from now on waits for a turn of its own.
    fn close_steering(&self, _session: &SessionHandle) {}
}

/// The context service, narrowed to the three questions a turn asks.
pub trait ContextPort: Send + Sync {
    /// Keep the runtime-context snapshot current; an unchanged snapshot writes nothing.
    fn record_runtime_context(
        &self,
        session: &SessionHandle,
        sections: &[RuntimeContextSection],
    ) -> Result<(), PortError>;

    /// Derive the request from the surface, prune, and summarise only if pruning did not clear the pressure.
    fn prepare<'a>(
        &'a self,
        session: &'a SessionHandle,
        options: PrepareOptions,
    ) -> BoxFuture<'a, Result<ContextReport, PortError>>;

    /// Derive the request without reducing it — what a granted retry sends.
    fn assemble(
        &self,
        session: &SessionHandle,
        options: PrepareOptions,
    ) -> Result<ContextReport, PortError>;
}

/// What the `agent/pre-step` waterfall sees and may replace.
#[derive(Debug, Clone, PartialEq)]
pub struct PreStep {
    /// The messages the round will send.
    pub messages: Vec<Message>,
    /// The tools it will offer.
    pub tools: Vec<ToolSpec>,
    /// Which round, from 1.
    pub round: u32,
}

/// How a hook ended a round.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HookFailure {
    /// A listener meant to refuse (TypeScript `HookRefusal`); its sentence is reported as is.
    #[error("{0}")]
    Refusal(String),
    /// A listener broke; reported as `a hook failed at agent/pre-step — <message>`.
    #[error("{0}")]
    Broken(String),
}

/// What one refused model call is offered on `agent/request-error`.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestErrorPayload {
    /// The failure's code and sentence.
    pub code: String,
    /// The sentence.
    pub message: String,
    /// The session.
    pub session: SessionHandle,
    /// The endpoint.
    pub endpoint: String,
    /// The model, when the turn named one.
    pub model: Option<String>,
    /// The conversation's folder.
    pub cwd: PathBuf,
    /// The tools the request carried.
    pub tools: Vec<ToolSpec>,
}

/// A listener's answer on `agent/request-error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestErrorAction {
    /// Something durable changed (a compaction landed): re-derive and send again.
    Retry,
}

/// The two hook points of a turn, modelled on DSH's `agent/pre-step` and `agent/request-error`.
///
/// The defaults do nothing, so [`NoTurnHooks`] is the composition without listeners.
pub trait TurnHooks: Send + Sync {
    /// Before a round's request is built; may replace its messages or tools, or end the round.
    fn pre_step(&self, step: PreStep) -> Result<PreStep, HookFailure> {
        Ok(step)
    }

    /// After a model call failed with a code; `Some(Retry)` only when a retry would differ.
    fn request_error<'a>(
        &'a self,
        payload: &'a RequestErrorPayload,
    ) -> BoxFuture<'a, Option<RequestErrorAction>> {
        let _ = payload;
        Box::pin(async { None })
    }

    /// Right after a round's runtime-context snapshot is recorded, before its request is assembled: the harness's
    /// own per-step notes (the time context, `recordTimeContext` in `src/agent/loop.ts`). `step` is the round's
    /// number in its turn, from 1. A failure fails the turn, as a failed snapshot does.
    fn record_step_context(&self, session: &SessionHandle, step: u32) -> Result<(), PortError> {
        let _ = (session, step);
        Ok(())
    }
}

/// A [`TurnHooks`] with no listeners.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoTurnHooks;

impl TurnHooks for NoTurnHooks {}

/// Several [`TurnHooks`] as one, in order — how the event bus's listeners and the context service's overflow
/// recovery share a turn.
///
/// Both points are waterfalls in the TypeScript build: `pre_step` passes each listener's step to the next and the
/// first failure ends the round; `request_error` asks each in turn and the first that answers decides (a listener
/// that passes calls `next`), so a later listener is not asked once a retry is granted.
#[derive(Clone, Default)]
pub struct ChainedTurnHooks {
    hooks: Vec<Arc<dyn TurnHooks>>,
}

impl ChainedTurnHooks {
    /// The listeners, asked in this order.
    pub fn new(hooks: Vec<Arc<dyn TurnHooks>>) -> Self {
        Self { hooks }
    }
}

impl TurnHooks for ChainedTurnHooks {
    fn pre_step(&self, step: PreStep) -> Result<PreStep, HookFailure> {
        self.hooks
            .iter()
            .try_fold(step, |step, hooks| hooks.pre_step(step))
    }

    fn request_error<'a>(
        &'a self,
        payload: &'a RequestErrorPayload,
    ) -> BoxFuture<'a, Option<RequestErrorAction>> {
        Box::pin(async move {
            for hooks in &self.hooks {
                if let Some(action) = hooks.request_error(payload).await {
                    return Some(action);
                }
            }
            None
        })
    }

    fn record_step_context(&self, session: &SessionHandle, step: u32) -> Result<(), PortError> {
        self.hooks
            .iter()
            .try_for_each(|hooks| hooks.record_step_context(session, step))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Named {
        name: &'static str,
        answer: Option<RequestErrorAction>,
        asked: std::sync::Mutex<Vec<&'static str>>,
        refuse: bool,
    }

    impl Named {
        fn new(name: &'static str, answer: Option<RequestErrorAction>, refuse: bool) -> Arc<Self> {
            Arc::new(Self {
                name,
                answer,
                asked: std::sync::Mutex::new(Vec::new()),
                refuse,
            })
        }
    }

    impl TurnHooks for Named {
        fn pre_step(&self, mut step: PreStep) -> Result<PreStep, HookFailure> {
            if self.refuse {
                return Err(HookFailure::Refusal(format!("{} refused", self.name)));
            }
            step.tools.push(ToolSpec {
                name: self.name.to_owned(),
                description: String::new(),
                parameters: serde_json::json!({}),
            });
            Ok(step)
        }

        fn request_error<'a>(
            &'a self,
            _: &'a RequestErrorPayload,
        ) -> BoxFuture<'a, Option<RequestErrorAction>> {
            self.asked.lock().unwrap().push(self.name);
            let answer = self.answer;
            Box::pin(async move { answer })
        }
    }

    fn step() -> PreStep {
        PreStep {
            round: 1,
            messages: Vec::new(),
            tools: Vec::new(),
        }
    }

    #[test]
    fn a_chain_passes_each_listeners_step_to_the_next_and_stops_at_a_refusal() {
        let chain = ChainedTurnHooks::new(vec![
            Named::new("a", None, false),
            Named::new("b", None, false),
        ]);
        let names: Vec<String> = chain
            .pre_step(step())
            .unwrap()
            .tools
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert_eq!(
            names,
            ["a", "b"],
            "each listener saw the step the one before left"
        );
        let refusing = ChainedTurnHooks::new(vec![
            Named::new("a", None, true),
            Named::new("b", None, false),
        ]);
        assert!(matches!(
            refusing.pre_step(step()),
            Err(HookFailure::Refusal(message)) if message == "a refused"
        ));
    }

    #[tokio::test]
    async fn a_chain_asks_each_listener_until_one_grants_a_retry() {
        let first = Named::new("bus", None, false);
        let second = Named::new("context", Some(RequestErrorAction::Retry), false);
        let third = Named::new("after", Some(RequestErrorAction::Retry), false);
        let chain = ChainedTurnHooks::new(vec![
            Arc::clone(&first) as Arc<dyn TurnHooks>,
            Arc::clone(&second) as Arc<dyn TurnHooks>,
            Arc::clone(&third) as Arc<dyn TurnHooks>,
        ]);
        let payload = RequestErrorPayload {
            code: "CONTEXT_WINDOW_EXCEEDED".into(),
            message: "too long".into(),
            session: SessionHandle {
                id: "s".into(),
                dir: "/s".into(),
                transcript: "/s/t".into(),
                meta: "/s/m".into(),
            },
            endpoint: "scripted".into(),
            model: None,
            cwd: PathBuf::from("/w"),
            tools: Vec::new(),
        };
        assert_eq!(
            chain.request_error(&payload).await,
            Some(RequestErrorAction::Retry)
        );
        assert_eq!(*first.asked.lock().unwrap(), ["bus"]);
        assert_eq!(*second.asked.lock().unwrap(), ["context"]);
        assert!(
            third.asked.lock().unwrap().is_empty(),
            "a granted retry ends the waterfall"
        );
        assert_eq!(
            ChainedTurnHooks::default().request_error(&payload).await,
            None
        );
    }
}
