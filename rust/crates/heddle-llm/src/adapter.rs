//! The [`Adapter`] trait, the choice of adapter for an endpoint, and the driver that folds an event stream.
//!
//! Ported from `Adapter`, `adapterFor`, `reasoningValue`, `post` and `hop` in `src/llm/{types,adapters}.ts`.
//!
//! Each HTTP adapter is split in two halves that are judged separately:
//!
//! - a **pure request builder** (`chat_request`, `responses_request`, `anthropic_call`) that returns a
//!   [`PreparedCall`] — URL, JSON body, headers, streaming flag — so the translation is asserted without a socket;
//! - a **pure fold** implementing [`StreamFold`] that turns parsed events into [`Chunk`]s, so the provider's event
//!   vocabulary is asserted by feeding it literals.
//!
//! [`fold_sse`] drives a fold over a live body. Cancellation is by **dropping** the [`ChunkStream`]: the request is
//! abandoned with it. A caller that wants an `ABORTED` error constructs one; nothing here takes a signal.

use std::pin::Pin;
use std::sync::Arc;

use futures::Stream;

use crate::endpoint::{EndpointConfig, WireValue};
use crate::error::ModelError;
use crate::http::ByteStream;
use crate::sse::SseEvent;
use crate::types::{Chunk, GenerateRequest};

/// One call's answer, chunk by chunk. An error ends it.
pub type ChunkStream = Pin<Box<dyn Stream<Item = Result<Chunk, ModelError>> + Send + 'static>>;

/// A provider backend: one wire shape, one endpoint.
pub trait Adapter: Send + Sync {
    /// The endpoint this adapter was built for.
    fn endpoint(&self) -> &EndpointConfig;

    /// One call, streamed. A failure building the request is the stream's first (and only) item.
    fn stream(&self, request: GenerateRequest) -> ChunkStream;
}

/// The adapter for an endpoint's declared kind (`adapterFor`). An [`crate::EndpointKind::Other`] kind is refused
/// with `UNKNOWN_KIND`.
pub fn adapter_for(endpoint: EndpointConfig) -> Result<Arc<dyn Adapter>, ModelError> {
    let _ = endpoint;
    todo!("port adapterFor")
}

/// A request translated for one wire shape, before it is sent.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCall {
    pub url: String,
    pub body: serde_json::Value,
    /// Headers to send beyond the client's defaults (configured headers, Title-Cased).
    pub headers: Vec<(String, String)>,
    /// Whether the body asks the provider to stream.
    pub stream: bool,
}

/// The wire value of the reasoning level a request names (`reasoningValue`).
///
/// `Ok(None)` when no level is requested or the level's value is `null` (both send nothing); an id the model does
/// not declare is a loud `UNSUPPORTED_REASONING_EFFORT` naming the declared ids, never a silent drop. The level is
/// looked up on the model that will answer: `request.model`, else the endpoint's.
pub fn reasoning_value(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<Option<WireValue>, ModelError> {
    let _ = (endpoint, request);
    todo!("port reasoningValue")
}

/// What one parsed event did to a fold.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Folded {
    /// Chunks to hand on, in order.
    pub chunks: Vec<Chunk>,
    /// The provider's terminal event arrived; the driver stops reading.
    pub finished: bool,
}

/// A provider's event vocabulary folded into chunks, one event at a time.
pub trait StreamFold: Send {
    /// One event in. A provider-reported failure is an error (`REMOTE`); an unparseable `data:` is skipped.
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError>;

    /// The body ended without a terminal event: whatever the fold still owes (assembled tool calls, a `done`).
    fn end(&mut self) -> Vec<Chunk>;
}

/// Drive a fold over a streamed body: parse events, fold each, stop at the terminal one or at the body's end.
pub fn fold_sse(body: ByteStream, fold: Box<dyn StreamFold>) -> ChunkStream {
    let _ = (body, fold);
    todo!("port the adapters' read loop")
}
