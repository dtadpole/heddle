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

/// The model service: one streaming call.
pub trait ModelPort: Send + Sync {
    /// Stream one call's chunks. The stream ends after `done`, or with an error item; `cancel` aborts the
    /// provider connection.
    fn stream(
        &self,
        request: GenerateRequest,
        cancel: Option<CancellationToken>,
    ) -> BoxStream<'static, Result<Chunk, ModelError>>;

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
}

/// A [`TurnHooks`] with no listeners.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoTurnHooks;

impl TurnHooks for NoTurnHooks {}
