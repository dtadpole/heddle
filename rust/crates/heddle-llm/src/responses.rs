//! OpenAI's Responses shape — the only one the Codex route offers.
//!
//! Ported from `openAiResponsesAdapter`, `toResponsesContent`, `toResponsesInput` and `responsesFinishReason` in
//! `src/llm/adapters.ts`. Measured contracts enforced here: `input` is a **list**, `stream` is always **true**
//! (`false` is a `400`), `store: false`, and the stream ends on `response.completed` / `response.incomplete` /
//! `response.failed` with no `[DONE]`. A reasoning-configured endpoint asks for `reasoning.summary: "auto"`, without
//! which the route streams no reasoning at all.

use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, Folded, PreparedCall, StreamFold};
use crate::endpoint::EndpointConfig;
use crate::error::ModelError;
use crate::sse::SseEvent;
use crate::types::{Chunk, ContentPart, GenerateRequest, Message, ToolCall};

/// The Responses adapter for one endpoint.
#[derive(Debug, Clone)]
pub struct ResponsesAdapter {
    endpoint: EndpointConfig,
}

impl ResponsesAdapter {
    pub fn new(endpoint: EndpointConfig) -> Self {
        Self { endpoint }
    }
}

impl Adapter for ResponsesAdapter {
    fn endpoint(&self) -> &EndpointConfig {
        &self.endpoint
    }

    fn stream(&self, request: GenerateRequest) -> ChunkStream {
        let _ = request;
        todo!("port openAiResponsesAdapter")
    }
}

/// Who speaks a Responses message; it decides the text part's type (`input_text` vs `output_text`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponsesRole {
    User,
    Assistant,
    Developer,
}

/// The request as this route takes it: `model`, `input`, `store: false`, `stream: true`, `reasoning`
/// (`effort` and/or `summary: "auto"`), `tools` (flat `{type:'function', name, …}`), `max_output_tokens`.
pub fn responses_request(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<PreparedCall, ModelError> {
    let _ = (endpoint, request);
    todo!("port the openAiResponsesAdapter body builder")
}

/// One message's content (`toResponsesContent`): text as `input_text` (or `output_text` for an assistant), an image
/// with data as `input_image` with a data URL; everything else dropped.
pub fn to_responses_content(parts: &[ContentPart], role: ResponsesRole) -> Vec<Value> {
    let _ = (parts, role);
    todo!("port toResponsesContent")
}

/// The `input` list (`toResponsesInput`): a tool result is a `function_call_output` item, a tool call a
/// `function_call` item beside its message, `system` speaks as `developer`, and an assistant message with no
/// content is not sent.
pub fn to_responses_input(messages: &[Message]) -> Vec<Value> {
    let _ = messages;
    todo!("port toResponsesInput")
}

/// The loop's finish reason for a terminal event (`responsesFinishReason`): `response.incomplete` reports its own
/// `incomplete_details.reason` (canonicalised); anything else is `completed` → `stop`, or `tool_calls` when calls
/// were made.
pub fn responses_finish_reason(
    terminal: &str,
    incomplete_reason: Option<&str>,
    tool_calls: usize,
) -> String {
    let _ = (terminal, incomplete_reason, tool_calls);
    todo!("port responsesFinishReason")
}

/// The streamed fold. Function calls are keyed by the item's `id` (which the argument deltas name), not its
/// `call_id`; the completed response restates every call and fills what the deltas left empty. A body that ends with
/// no terminal event finishes `stream_ended`, never `stop`.
#[derive(Debug, Default)]
pub struct ResponsesFold {
    calls: Vec<(String, ToolCall)>,
    usage: Option<crate::usage::TokenUsage>,
}

impl ResponsesFold {
    pub fn new() -> Self {
        Self::default()
    }
}

impl StreamFold for ResponsesFold {
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError> {
        let _ = (event, &mut self.calls, &mut self.usage);
        todo!("port the Responses read loop")
    }

    fn end(&mut self) -> Vec<Chunk> {
        todo!("port the Responses stream tail")
    }
}
