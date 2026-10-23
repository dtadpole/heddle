//! Anthropic's Messages shape on a cloud publisher route.
//!
//! Ported from `anthropicCall`, `toAnthropicContent`, `toAnthropicMessages`, `anthropicChunks` and
//! `anthropicVertexAdapter` in `src/llm/adapters.ts`. The URL is
//! `{base_url_for(model)}/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:streamRawPredict`;
//! the version ([`ANTHROPIC_VERTEX_VERSION`]) and `stream: true` travel in the body. Rules that are each a provider
//! refusal when wrong: the system prompt is a top-level field; a tool call is a `tool_use` block with **parsed**
//! input and its result a `tool_result` block on a user turn; adjacent same-role turns merge; reasoning is never
//! replayed (a thinking block needs the provider's signature). A requested level is sent as
//! `thinking: {type: "adaptive", display: "summarized"}` plus `output_config.effort`.

use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, Folded, PreparedCall, StreamFold};
use crate::error::ModelError;
use crate::sse::SseEvent;
use crate::types::{Chunk, ContentPart, GenerateRequest, Message, ToolCall};
use heddle_config::EndpointConfig;

/// The body version a publisher route requires; it is not a header on this shape.
pub const ANTHROPIC_VERTEX_VERSION: &str = "vertex-2023-10-16";

/// The cap a call with none gets: the route requires `max_tokens`.
pub const DEFAULT_MAX_TOKENS: u64 = 4096;

/// The publisher-route adapter for one endpoint.
#[derive(Debug, Clone)]
pub struct AnthropicVertexAdapter {
    endpoint: EndpointConfig,
}

impl AnthropicVertexAdapter {
    pub fn new(endpoint: EndpointConfig) -> Self {
        Self { endpoint }
    }
}

impl Adapter for AnthropicVertexAdapter {
    fn endpoint(&self) -> &EndpointConfig {
        &self.endpoint
    }

    fn stream(&self, request: GenerateRequest) -> ChunkStream {
        let _ = request;
        todo!("port anthropicVertexAdapter")
    }
}

/// The URL, body and headers for the publisher route (`anthropicCall`). `NO_PROJECT`, `NO_REGION` and `NO_MODEL`
/// when the endpoint cannot be addressed.
pub fn anthropic_call(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<PreparedCall, ModelError> {
    let _ = (endpoint, request);
    todo!("port anthropicCall")
}

/// One message's content (`toAnthropicContent`): text blocks and base64 image blocks.
pub fn to_anthropic_content(parts: &[ContentPart]) -> Vec<Value> {
    let _ = parts;
    todo!("port toAnthropicContent")
}

/// The message list as Anthropic reads it (`toAnthropicMessages`), the system prompt left to the top-level field.
pub fn to_anthropic_messages(messages: &[Message]) -> Vec<Value> {
    let _ = messages;
    todo!("port toAnthropicMessages")
}

/// The event-stream fold (`anthropicChunks`): `text_delta`, `thinking_delta`, `tool_use` blocks with
/// `input_json_delta` fragments, the stop reason and output count from `message_delta`, the end at `message_stop`;
/// an `error` event is `REMOTE`.
#[derive(Debug)]
pub struct AnthropicFold {
    endpoint: String,
    calls: Vec<(u32, ToolCall)>,
    finish_reason: String,
    usage: Option<crate::usage::TokenUsage>,
}

impl AnthropicFold {
    /// A fold for one call; the endpoint name goes into a `REMOTE` error's sentence.
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            calls: Vec::new(),
            finish_reason: "stop".to_owned(),
            usage: None,
        }
    }
}

impl StreamFold for AnthropicFold {
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError> {
        let _ = (
            event,
            &self.endpoint,
            &mut self.calls,
            &mut self.finish_reason,
            &mut self.usage,
        );
        todo!("port anthropicChunks")
    }

    fn end(&mut self) -> Vec<Chunk> {
        todo!("port the anthropicChunks tail")
    }
}
