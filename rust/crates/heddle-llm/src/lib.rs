//! `heddle-llm` — the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and
//! usage.
//!
//! Ported from the TypeScript build: `src/llm/`, `src/stream/printer.ts`, and the service half of
//! `src/plugins/model.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/10-llm-backends`,
//! `_verifiers_/20-streaming` and `_verifiers_/98-model-endpoints`.
//!
//! # The shape
//!
//! A provider-neutral [`ModelService`] owns a registry of endpoints and exposes **one streaming call**; an
//! [`Adapter`] per wire shape owns the request body and the fold of the provider's event stream into
//! [`Chunk`]s. Every call is a stream, a non-streaming transport included, so a consumer reads one shape.
//!
//! | Module | Ported from | What it holds |
//! |---|---|---|
//! | [`types`] | `llm/types.ts` | messages, content parts, tool specs, requests, chunks, finish reasons |
//! | [`endpoint`] | `llm/types.ts` | the endpoint configuration and its model catalogue lookups |
//! | [`error`] | `llm/types.ts` | [`ModelError`] and its codes |
//! | [`usage`] | `llm/usage.ts` | [`TokenUsage`] and each provider's normalisation |
//! | [`sse`] | `llm/adapters.ts` | the incremental `text/event-stream` parser |
//! | [`http`] | `llm/http.ts` | the one HTTP client every adapter and the model list share |
//! | [`adapter`] | `llm/adapters.ts` | the [`Adapter`] trait, `adapter_for`, the stream fold driver |
//! | [`chat`], [`responses`], [`anthropic`], [`scripted`] | `llm/adapters.ts` | one module per wire shape |
//! | [`attachments`] | `llm/attachments.ts` | what a provider is sent for an attached image or file |
//! | [`model_info`] | `llm/model-info.ts` | the provider's model list: context window and input modalities |
//! | [`service`] | `llm/service.ts`, `plugins/model.ts` | [`ModelService`] and the `model/*` hook seam |
//! | [`printer`] | `stream/printer.ts` | the live stream view on standard error |
//!
//! # Contract status
//!
//! The public API is declared; bodies marked `todo!()` are being ported (see `INDEX.md`, "Port plan"). Data types
//! and their JSON shapes are final and tested, so a dependent crate can build and serialize against them today.

pub mod adapter;
pub mod anthropic;
pub mod attachments;
pub mod chat;
pub mod endpoint;
pub mod error;
pub mod http;
pub mod model_info;
pub mod printer;
pub mod responses;
pub mod scripted;
pub mod service;
pub mod sse;
pub mod types;
pub mod usage;

pub use adapter::{Adapter, ChunkStream, adapter_for};
pub use endpoint::{
    EndpointConfig, EndpointKind, InputModality, ModelEntry, ModelOption, ReasoningLevel,
    ReasoningLevels, WireValue,
};
pub use error::{CONTEXT_WINDOW_EXCEEDED, ModelError};
pub use printer::{StreamPrinter, StreamPrinterOptions, StreamSummary};
pub use service::{Generated, ModelHooks, ModelService, ProbeOptions, ProbeResult};
pub use types::{
    Chunk, ContentPart, FilePart, GenerateRequest, ImageMediaType, ImagePart, Message, Role,
    ToolCall, ToolSpec,
};
pub use usage::TokenUsage;
