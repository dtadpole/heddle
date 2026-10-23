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
//! The endpoint vocabulary — [`EndpointConfig`], its model catalogue and the lookups `offered_models`,
//! `base_url_for`, `context_window_for`, `reasoning_level_for` — is `heddle-config`'s and is re-exported here, so a
//! caller names one type whichever crate it reaches it through.
//!
//! # Contract status
//!
//! The public API is declared, its JSON shapes are final, and every body is implemented and tested in-process (see
//! `INDEX.md`, "Port plan"). The verifiers judge the binary that composes this crate; nothing here reads
//! configuration files, sessions or the event bus.

pub mod adapter;
pub mod anthropic;
pub mod attachments;
pub mod chat;
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
pub use error::{CONTEXT_WINDOW_EXCEEDED, ModelError};
pub use heddle_config::{
    EndpointConfig, EndpointKind, ModelEntry, ModelOption, ReasoningLevel, ReasoningLevels,
    ReasoningValue,
};
pub use model_info::InputModality;
pub use printer::{StreamPrinter, StreamPrinterOptions, StreamSummary};
pub use service::{Generated, ModelHooks, ModelService, ProbeOptions, ProbeResult};
pub use types::{
    Chunk, ContentPart, FilePart, GenerateRequest, ImageMediaType, ImagePart, Message, Role,
    ToolCall, ToolSpec,
};
pub use usage::TokenUsage;
