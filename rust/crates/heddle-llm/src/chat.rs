//! OpenAI's Chat Completions shape — the DeepSeek route and every OpenAI-compatible gateway.
//!
//! Ported from `openAiChatAdapter`, `toChatMessage` and `finishFromChatMessage` in `src/llm/adapters.ts`.
//! `POST {base_url_for(model)}/chat/completions`; streams unless the endpoint or request says not to; ends on
//! `[DONE]` or the frame carrying `finish_reason`. Reasoning arrives as `reasoning_content` and becomes
//! [`Chunk::ReasoningDelta`]; tool-call fragments are passed on live as [`Chunk::ToolCallDelta`] and assembled
//! by `index` into one [`Chunk::ToolCall`] each when the round finishes.

use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, Folded, PreparedCall, StreamFold};
use crate::endpoint::EndpointConfig;
use crate::error::ModelError;
use crate::sse::SseEvent;
use crate::types::{Chunk, GenerateRequest, Message};

/// The Chat Completions adapter for one endpoint.
#[derive(Debug, Clone)]
pub struct ChatAdapter {
    endpoint: EndpointConfig,
}

impl ChatAdapter {
    pub fn new(endpoint: EndpointConfig) -> Self {
        Self { endpoint }
    }
}

impl Adapter for ChatAdapter {
    fn endpoint(&self) -> &EndpointConfig {
        &self.endpoint
    }

    fn stream(&self, request: GenerateRequest) -> ChunkStream {
        let _ = request;
        todo!("port openAiChatAdapter")
    }
}

/// The request as this route takes it: `model`, `messages`, `tools` (as `{type:'function', function:{…}}`),
/// `max_tokens` (request, else endpoint), `temperature`, `reasoning_effort` (the level's wire value), `stream`
/// (endpoint's force, else request's, else `true`).
pub fn chat_request(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<PreparedCall, ModelError> {
    let _ = (endpoint, request);
    todo!("port the openAiChatAdapter body builder")
}

/// One message in this shape (`toChatMessage`): text parts joined by `\n` as a string `content` (`null` when there
/// is none); a message with images switches to typed parts with `image_url` data URLs; tool calls become
/// `tool_calls`; a tool result carries `tool_call_id`.
pub fn to_chat_message(message: &Message) -> Value {
    let _ = message;
    todo!("port toChatMessage")
}

/// A non-streamed answer reduced to the same chunks (`finishFromChatMessage`).
pub fn chunks_from_chat_json(answer: &Value) -> Vec<Chunk> {
    let _ = answer;
    todo!("port finishFromChatMessage")
}

/// The streamed fold: deltas, live tool-call fragments, assembly by `index`, `done` on `finish_reason` with usage
/// from the same frame; `[DONE]` with no finish frame is a plain `stop`.
#[derive(Debug, Default)]
pub struct ChatFold {
    calls: Vec<(u32, crate::types::ToolCall)>,
}

impl ChatFold {
    pub fn new() -> Self {
        Self::default()
    }
}

impl StreamFold for ChatFold {
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError> {
        let _ = (event, &mut self.calls);
        todo!("port the chat read loop")
    }

    fn end(&mut self) -> Vec<Chunk> {
        todo!("port the chat stream tail")
    }
}
