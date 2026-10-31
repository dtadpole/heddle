//! OpenAI's Responses shape — the only one the Codex route offers.
//!
//! Ported from `openAiResponsesAdapter`, `toResponsesContent`, `toResponsesInput` and `responsesFinishReason` in
//! `src/llm/adapters.ts`. Measured contracts enforced here: `input` is a **list**, `stream` is always **true**
//! (`false` is a `400`), `store: false`, and the stream ends on `response.completed` / `response.incomplete` /
//! `response.failed` with no `[DONE]`. A reasoning-configured endpoint asks for `reasoning.summary: "auto"`, without
//! which the route streams no reasoning at all.

use futures::StreamExt;
use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, Folded, PreparedCall, StreamFold, fold_sse};
use crate::error::ModelError;
use crate::http::{Method, WireRequest, WireResponse, wire};
use crate::sse::SseEvent;
use crate::types::{Chunk, ContentPart, GenerateRequest, Message, ToolCall};
use heddle_config::EndpointConfig;

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
        let prepared = match responses_request(&self.endpoint, &request) {
            Ok(prepared) => prepared,
            Err(error) => return crate::adapter::error_stream(error),
        };
        let endpoint = self.endpoint.clone();
        let lazy = futures::stream::once(async move {
            let call = WireRequest {
                url: prepared.url,
                method: Method::Post,
                body: Some(prepared.body),
                headers: prepared.headers,
                api_key: endpoint.api_key.clone(),
                stream: prepared.stream,
                timeout_ms: endpoint.timeout_ms,
                endpoint: endpoint.name.clone(),
                proxy: endpoint.proxy.clone(),
            };
            let stream: ChunkStream = match wire(call).await {
                // This route always streams; a buffered answer is not what it promises.
                Ok(WireResponse::Json(_)) => crate::adapter::error_stream(ModelError::new(
                    format!(
                        "'{}' answered the Responses route without a stream",
                        endpoint.name
                    ),
                    endpoint.name.clone(),
                    crate::error::code::BAD_BODY,
                )),
                Ok(WireResponse::Stream { body, .. }) => {
                    let fold = ResponsesFold::new().with_endpoint(endpoint.name.clone());
                    fold_sse(body, Box::new(fold))
                }
                Err(error) => crate::adapter::error_stream(error),
            };
            stream
        });
        Box::pin(lazy.flatten())
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
    let mut body = serde_json::Map::new();
    if let Some(model) = request.model.as_ref().or(endpoint.model.as_ref()) {
        body.insert("model".into(), Value::String(model.clone()));
    }
    body.insert(
        "input".into(),
        Value::Array(to_responses_input(&request.messages)),
    );
    body.insert("store".into(), Value::Bool(false));
    // The route refuses `stream: false`, so this shape always streams.
    body.insert("stream".into(), Value::Bool(true));

    let effort = crate::adapter::reasoning_value(endpoint, request)?;
    let mut reasoning = serde_json::Map::new();
    if let Some(value) = effort {
        reasoning.insert(
            "effort".into(),
            serde_json::to_value(value).unwrap_or(Value::Null),
        );
    }
    // A reasoning model reasons even with no level chosen, but the route only streams its summary when asked.
    if crate::adapter::reasoning_configured(endpoint) {
        reasoning.insert("summary".into(), Value::String("auto".into()));
    }
    if !reasoning.is_empty() {
        body.insert("reasoning".into(), Value::Object(reasoning));
    }

    if !request.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        serde_json::json!({
                            "type": "function",
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters
                        })
                    })
                    .collect(),
            ),
        );
    }
    if let Some(max_output_tokens) = request.max_output_tokens.or(endpoint.max_output_tokens) {
        body.insert("max_output_tokens".into(), Value::from(max_output_tokens));
    }

    Ok(PreparedCall {
        url: format!(
            "{}/responses",
            endpoint.base_url_for(request.model.as_deref())
        ),
        body: Value::Object(body),
        headers: crate::http::title_case_headers(
            &endpoint
                .headers
                .iter()
                .flatten()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect::<Vec<_>>(),
        ),
        stream: true,
    })
}

/// One message's content (`toResponsesContent`): text as `input_text` (or `output_text` for an assistant), an image
/// with data as `input_image` with a data URL; everything else dropped.
pub fn to_responses_content(parts: &[ContentPart], role: ResponsesRole) -> Vec<Value> {
    // The part's type depends on who is speaking: an assistant's text is `output_text`, and the route refuses
    // `input_text` there.
    let text_type = if role == ResponsesRole::Assistant {
        "output_text"
    } else {
        "input_text"
    };
    let mut content = Vec::new();
    for part in parts {
        match part {
            ContentPart::Text { text } => {
                content.push(serde_json::json!({ "type": text_type, "text": text }));
            }
            ContentPart::Image(image) => {
                if let Some(data) = &image.data {
                    content.push(serde_json::json!({
                        "type": "input_image",
                        "image_url": format!("data:{};base64,{data}", image.mime_type.as_str())
                    }));
                }
            }
            _ => {}
        }
    }
    content
}

/// The `input` list (`toResponsesInput`): a tool result is a `function_call_output` item, a tool call a
/// `function_call` item beside its message, `system` speaks as `developer`, and an assistant message with no
/// content is not sent.
pub fn to_responses_input(messages: &[Message]) -> Vec<Value> {
    let mut items = Vec::new();
    for message in messages {
        if message.role == crate::types::Role::Tool {
            let output = message
                .content
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            items.push(serde_json::json!({
                "type": "function_call_output",
                "call_id": message.tool_call_id.clone().unwrap_or_default(),
                "output": output
            }));
            continue;
        }
        let role = match message.role {
            crate::types::Role::System => ResponsesRole::Developer,
            crate::types::Role::Assistant => ResponsesRole::Assistant,
            _ => ResponsesRole::User,
        };
        let content = to_responses_content(&message.content, role);
        if !content.is_empty() {
            let role = match role {
                ResponsesRole::User => "user",
                ResponsesRole::Assistant => "assistant",
                ResponsesRole::Developer => "developer",
            };
            items.push(serde_json::json!({ "role": role, "content": content }));
        }
        // A tool call is an item beside the message, because this shape has no content part for one.
        for part in &message.content {
            if let ContentPart::ToolCall(call) = part {
                items.push(serde_json::json!({
                    "type": "function_call",
                    "call_id": call.id,
                    "name": call.name,
                    "arguments": call.arguments
                }));
            }
        }
    }
    items
}

/// The loop's finish reason for a terminal event (`responsesFinishReason`): `response.incomplete` reports its own
/// `incomplete_details.reason` (canonicalised); anything else is `completed` → `stop`, or `tool_calls` when calls
/// were made.
pub fn responses_finish_reason(
    terminal: &str,
    incomplete_reason: Option<&str>,
    tool_calls: usize,
) -> String {
    if terminal == "response.incomplete" {
        // A cut response reports its own reason (`max_output_tokens`, `content_filter`), not a made-up one.
        return crate::types::canonical_finish_reason(
            Some(incomplete_reason.unwrap_or("incomplete")),
            0,
        );
    }
    crate::types::canonical_finish_reason(Some("completed"), tool_calls)
}

/// The streamed fold. Function calls are keyed by the item's `id` (which the argument deltas name), not its
/// `call_id`; the completed response restates every call and fills what the deltas left empty. A body that ends with
/// no terminal event finishes `stream_ended`, never `stop`.
#[derive(Debug, Default)]
pub struct ResponsesFold {
    calls: Vec<(String, ToolCall)>,
    usage: Option<crate::usage::TokenUsage>,
    /// The endpoint name a `REMOTE` error names; empty when the caller did not say.
    endpoint: String,
}

impl ResponsesFold {
    pub fn new() -> Self {
        Self::default()
    }

    /// The same fold, naming its endpoint in a `REMOTE` error a person reads.
    #[must_use]
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    /// The call an `item_id` names, created on first sight when a delta arrives before its item.
    fn call_mut(&mut self, key: &str) -> &mut ToolCall {
        if let Some(at) = self.calls.iter().position(|(slot, _)| slot == key) {
            return &mut self.calls[at].1;
        }
        self.calls.push((
            key.to_string(),
            ToolCall {
                id: key.to_string(),
                ..ToolCall::default()
            },
        ));
        &mut self.calls.last_mut().expect("just pushed").1
    }

    /// Fill what the deltas left empty from the completed response's restatement.
    fn restate(&mut self, item: &Value) {
        let id = item
            .get("call_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = item.get("name").and_then(Value::as_str);
        let arguments = item.get("arguments").and_then(Value::as_str);
        match self.calls.iter().position(|(_, call)| call.id == id) {
            None if !id.is_empty() => {
                self.calls.push((
                    id.to_string(),
                    ToolCall {
                        id: id.to_string(),
                        name: name.unwrap_or_default().to_string(),
                        arguments: arguments.unwrap_or_default().to_string(),
                    },
                ));
            }
            Some(at) => {
                let call = &mut self.calls[at].1;
                if call.name.is_empty()
                    && let Some(name) = name
                {
                    call.name = name.to_string();
                    if call.arguments.is_empty() {
                        call.arguments = arguments.unwrap_or_default().to_string();
                    }
                }
            }
            None => {}
        }
    }
}

impl StreamFold for ResponsesFold {
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError> {
        let parsed: Value = match serde_json::from_str(&event.data) {
            Ok(parsed) => parsed,
            // An unparseable `data:` is skipped.
            Err(_) => return Ok(Folded::default()),
        };
        let kind = parsed
            .get("type")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| event.event.clone())
            .unwrap_or_default();
        let mut chunks = Vec::new();
        match kind.as_str() {
            "response.output_text.delta" => {
                if let Some(delta) = parsed.get("delta").and_then(Value::as_str) {
                    chunks.push(Chunk::TextDelta {
                        text: delta.to_string(),
                    });
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(delta) = parsed.get("delta").and_then(Value::as_str) {
                    chunks.push(Chunk::ReasoningDelta {
                        text: delta.to_string(),
                    });
                }
            }
            "response.output_item.added" => {
                if let Some(item) = parsed.get("item")
                    && item.get("type").and_then(Value::as_str) == Some("function_call")
                {
                    // Keyed by the item's own `id`, not its `call_id`: the argument deltas name the former.
                    let key = item
                        .get("id")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("call_id").and_then(Value::as_str))
                        .unwrap_or("call");
                    let id = item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("id").and_then(Value::as_str))
                        .unwrap_or("call");
                    let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                    let call = self.call_mut(key);
                    call.id = id.to_string();
                    call.name = name.to_string();
                }
            }
            "response.function_call_arguments.delta" => {
                let key = parsed
                    .get("item_id")
                    .and_then(Value::as_str)
                    .or_else(|| parsed.get("call_id").and_then(Value::as_str))
                    .unwrap_or("call");
                let delta = match parsed.get("delta") {
                    Some(Value::String(text)) => text.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                self.call_mut(key).arguments.push_str(&delta);
            }
            "response.completed" | "response.incomplete" => {
                let response = parsed.get("response");
                if response
                    .and_then(|response| response.get("usage"))
                    .is_some_and(|usage| !usage.is_null())
                {
                    self.usage = crate::usage::openai_responses_usage(
                        response
                            .and_then(|response| response.get("usage"))
                            .unwrap_or(&Value::Null),
                    );
                }
                for item in response
                    .and_then(|response| response.get("output"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|item| {
                        item.get("type").and_then(Value::as_str) == Some("function_call")
                    })
                {
                    self.restate(item);
                }
                chunks.extend(
                    self.calls
                        .iter()
                        .map(|(_, call)| Chunk::ToolCall(call.clone())),
                );
                let incomplete = response
                    .and_then(|response| response.get("incomplete_details"))
                    .and_then(|details| details.get("reason"))
                    .and_then(Value::as_str);
                chunks.push(Chunk::Done {
                    finish_reason: responses_finish_reason(&kind, incomplete, self.calls.len()),
                    usage: self.usage,
                });
                return Ok(Folded {
                    chunks,
                    finished: true,
                });
            }
            "response.failed" | "error" => {
                let excerpt = serde_json::to_string(&parsed).unwrap_or_default();
                let excerpt: String = excerpt.chars().take(300).collect();
                let who = if self.endpoint.is_empty() {
                    "the Responses route".to_string()
                } else {
                    format!("'{}'", self.endpoint)
                };
                return Err(ModelError::new(
                    format!("{who} reported a failed response — {excerpt}"),
                    self.endpoint.clone(),
                    crate::error::code::REMOTE,
                ));
            }
            _ => {}
        }
        Ok(Folded {
            chunks,
            finished: false,
        })
    }

    fn end(&mut self) -> Vec<Chunk> {
        let mut chunks: Vec<Chunk> = self
            .calls
            .iter()
            .map(|(_, call)| Chunk::ToolCall(call.clone()))
            .collect();
        // A body that ends on no terminal event was cut; saying `stop` would present it as finished.
        chunks.push(Chunk::Done {
            finish_reason: "stream_ended".into(),
            usage: self.usage,
        });
        chunks
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::user_message;
    use crate::usage::TokenUsage;

    fn sse(event: &str, value: serde_json::Value) -> SseEvent {
        SseEvent {
            event: Some(event.to_string()),
            data: value.to_string(),
        }
    }

    fn payload(value: serde_json::Value) -> SseEvent {
        SseEvent {
            event: None,
            data: value.to_string(),
        }
    }

    #[test]
    fn an_incomplete_response_reports_its_own_reason_and_a_completed_one_the_loops_words() {
        assert_eq!(
            responses_finish_reason("response.completed", None, 0),
            "stop"
        );
        assert_eq!(
            responses_finish_reason("response.completed", None, 2),
            "tool_calls",
            "the Responses shape says completed whether or not it asked for tools"
        );
        assert_eq!(
            responses_finish_reason("response.incomplete", Some("max_output_tokens"), 0),
            "max_output_tokens"
        );
        assert_eq!(
            responses_finish_reason("response.incomplete", Some("content_filter"), 0),
            "content_filter"
        );
        assert_eq!(
            responses_finish_reason("response.incomplete", None, 1),
            "incomplete"
        );
    }

    #[test]
    fn text_and_reasoning_summaries_arrive_as_deltas() {
        let mut fold = ResponsesFold::new();
        assert_eq!(
            fold.event(&payload(serde_json::json!({
                "type": "response.output_text.delta",
                "delta": "an"
            })))
            .expect("folds")
            .chunks,
            vec![Chunk::TextDelta { text: "an".into() }]
        );
        assert_eq!(
            fold.event(&payload(serde_json::json!({
                "type": "response.reasoning_summary_text.delta",
                "delta": "hm"
            })))
            .expect("folds")
            .chunks,
            vec![Chunk::ReasoningDelta { text: "hm".into() }]
        );
    }

    #[test]
    fn a_function_call_is_keyed_by_the_item_id_its_argument_deltas_name() {
        let mut fold = ResponsesFold::new();
        // The item names the call `call_8xe` but its own id is `fc_1`, which the deltas carry.
        fold.event(&payload(serde_json::json!({
            "type": "response.output_item.added",
            "item": { "type": "function_call", "id": "fc_1", "call_id": "call_8xe", "name": "bash" }
        })))
        .expect("folds");
        let mut chunks = Vec::new();
        for fragment in ["{\"command\":", "\"ls\"}"] {
            chunks.extend(
                fold.event(&payload(serde_json::json!({
                    "type": "response.function_call_arguments.delta",
                    "item_id": "fc_1",
                    "delta": fragment
                })))
                .expect("folds")
                .chunks,
            );
        }
        assert!(
            chunks.is_empty(),
            "argument fragments are not chunks of their own"
        );

        let folded = fold
            .event(&sse(
                "response.completed",
                serde_json::json!({
                    "type": "response.completed",
                    "response": {
                        "status": "completed",
                        "usage": { "input_tokens": 5, "output_tokens": 2 },
                        "output": [{ "type": "function_call", "call_id": "call_8xe", "name": "bash", "arguments": "{\"command\":\"ls\"}" }]
                    }
                }),
            ))
            .expect("folds");
        assert_eq!(
            folded.chunks,
            vec![
                Chunk::ToolCall(crate::types::ToolCall {
                    id: "call_8xe".into(),
                    name: "bash".into(),
                    arguments: "{\"command\":\"ls\"}".into(),
                }),
                Chunk::Done {
                    finish_reason: "tool_calls".into(),
                    usage: Some(TokenUsage {
                        input_tokens: Some(5),
                        output_tokens: Some(2),
                        ..TokenUsage::default()
                    }),
                },
            ]
        );
        assert!(folded.finished);
    }

    #[test]
    fn the_completed_response_fills_a_name_only_it_restates() {
        let mut fold = ResponsesFold::new();
        // A delta arrives with no item metadata, so the call starts unnamed.
        fold.event(&payload(serde_json::json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_9",
            "delta": "{}"
        })))
        .expect("folds");
        let folded = fold
            .event(&sse(
                "response.completed",
                serde_json::json!({
                    "type": "response.completed",
                    "response": {
                        "status": "completed",
                        "output": [{ "type": "function_call", "call_id": "fc_9", "name": "read_file", "arguments": "{}" }]
                    }
                }),
            ))
            .expect("folds");
        assert_eq!(
            folded.chunks,
            vec![
                Chunk::ToolCall(crate::types::ToolCall {
                    id: "fc_9".into(),
                    name: "read_file".into(),
                    arguments: "{}".into(),
                }),
                Chunk::Done {
                    finish_reason: "tool_calls".into(),
                    usage: None,
                },
            ]
        );
    }

    #[test]
    fn a_body_that_ends_without_a_terminal_event_was_cut() {
        let mut fold = ResponsesFold::new();
        fold.event(&payload(serde_json::json!({
            "type": "response.output_text.delta",
            "delta": "partial"
        })))
        .expect("folds");
        assert_eq!(
            fold.end(),
            vec![Chunk::Done {
                finish_reason: "stream_ended".into(),
                usage: None,
            }]
        );
    }

    #[test]
    fn a_failed_response_is_remote_and_an_unparseable_frame_is_skipped() {
        let error = ResponsesFold::new()
            .event(&sse(
                "response.failed",
                serde_json::json!({ "type": "response.failed", "response": { "status": "failed" } }),
            ))
            .expect_err("fails");
        assert_eq!(error.code, crate::error::code::REMOTE);
        assert!(error.to_string().contains("failed response"), "{error}");

        let folded = ResponsesFold::new()
            .event(&payload(serde_json::json!({})))
            .expect("folds");
        assert!(folded.chunks.is_empty());
        assert!(!folded.finished);
    }

    #[test]
    fn an_assistant_message_is_output_text_and_every_other_role_is_input_text() {
        assert_eq!(
            to_responses_content(&[ContentPart::text("hi")], ResponsesRole::Assistant),
            vec![serde_json::json!({ "type": "output_text", "text": "hi" })]
        );
        assert_eq!(
            to_responses_content(&[ContentPart::text("hi")], ResponsesRole::User),
            vec![serde_json::json!({ "type": "input_text", "text": "hi" })]
        );
        assert_eq!(
            to_responses_content(&[ContentPart::text("hi")], ResponsesRole::Developer),
            vec![serde_json::json!({ "type": "input_text", "text": "hi" })]
        );
    }

    #[test]
    fn a_conversation_becomes_messages_function_calls_and_function_results_in_order() {
        let messages = vec![
            Message::new(
                crate::types::Role::System,
                vec![ContentPart::text("be brief")],
            ),
            Message::new(crate::types::Role::User, vec![ContentPart::text("run it")]),
            Message::new(
                crate::types::Role::Assistant,
                vec![ContentPart::ToolCall(crate::types::ToolCall {
                    id: "call_1".into(),
                    name: "bash".into(),
                    arguments: r#"{"command":"echo hi"}"#.into(),
                })],
            ),
            Message {
                role: crate::types::Role::Tool,
                tool_call_id: Some("call_1".into()),
                content: vec![ContentPart::text("hi")],
                source: None,
            },
            Message::new(
                crate::types::Role::Assistant,
                vec![ContentPart::text("it printed hi")],
            ),
        ];
        assert_eq!(
            to_responses_input(&messages),
            vec![
                serde_json::json!({ "role": "developer", "content": [{ "type": "input_text", "text": "be brief" }] }),
                serde_json::json!({ "role": "user", "content": [{ "type": "input_text", "text": "run it" }] }),
                serde_json::json!({ "type": "function_call", "call_id": "call_1", "name": "bash", "arguments": "{\"command\":\"echo hi\"}" }),
                serde_json::json!({ "type": "function_call_output", "call_id": "call_1", "output": "hi" }),
                serde_json::json!({ "role": "assistant", "content": [{ "type": "output_text", "text": "it printed hi" }] }),
            ]
        );
    }

    #[test]
    fn an_assistant_turn_made_only_of_reasoning_is_not_sent_as_an_empty_message() {
        let messages = vec![
            Message::new(crate::types::Role::User, vec![ContentPart::text("hello")]),
            Message::new(
                crate::types::Role::Assistant,
                vec![ContentPart::reasoning("one word")],
            ),
        ];
        assert_eq!(
            to_responses_input(&messages),
            vec![
                serde_json::json!({ "role": "user", "content": [{ "type": "input_text", "text": "hello" }] })
            ]
        );
    }

    #[test]
    fn a_tool_result_with_several_text_blocks_keeps_them_apart() {
        let messages = vec![Message {
            role: crate::types::Role::Tool,
            tool_call_id: Some("call_9".into()),
            content: vec![ContentPart::text("line one"), ContentPart::text("line two")],
            source: None,
        }];
        assert_eq!(
            to_responses_input(&messages),
            vec![serde_json::json!({
                "type": "function_call_output",
                "call_id": "call_9",
                "output": "line one\nline two"
            })]
        );
    }

    fn base_endpoint() -> EndpointConfig {
        EndpointConfig {
            name: "codex".into(),
            kind: heddle_config::EndpointKind::OpenaiResponses,
            base_url: "http://gateway.example/v1".into(),
            model: Some("m".into()),
            models: None,
            reasoning: None,
            project: None,
            region: None,
            api_key: None,
            api_key_file: None,
            headers: None,
            stream: None,
            max_output_tokens: None,
            context_window: None,
            capabilities: None,
            input_modalities: None,
            proxy: None,
            timeout_ms: None,
            prompt_cache: None,
        }
    }

    #[test]
    fn the_request_has_a_list_input_and_always_streams() {
        let request = GenerateRequest {
            endpoint: "codex".into(),
            messages: vec![user_message("hi")],
            max_output_tokens: Some(32),
            ..GenerateRequest::default()
        };
        let call = responses_request(&base_endpoint(), &request).expect("builds");
        assert_eq!(call.url, "http://gateway.example/v1/responses");
        assert!(call.stream);
        assert_eq!(call.body["model"], serde_json::json!("m"));
        assert_eq!(
            call.body["input"],
            serde_json::json!([{ "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }])
        );
        assert_eq!(call.body["store"], serde_json::json!(false));
        assert_eq!(call.body["stream"], serde_json::json!(true));
        assert_eq!(call.body["max_output_tokens"], serde_json::json!(32));
        // A shape that does not reason sends no `reasoning` field at all.
        assert!(call.body.get("reasoning").is_none());
    }

    #[test]
    fn a_reasoning_endpoint_asks_for_a_summary_and_nests_the_effort() {
        let mut endpoint = base_endpoint();
        endpoint.capabilities = Some(vec!["reasoning".into()]);
        endpoint.reasoning = Some(heddle_config::ReasoningLevels {
            default: None,
            levels: vec![heddle_config::ReasoningLevel {
                id: "high".into(),
                name: "High".into(),
                value: Some(heddle_config::ReasoningValue::Text("high".into())),
            }],
        });
        let call = responses_request(
            &endpoint,
            &GenerateRequest {
                endpoint: "codex".into(),
                messages: vec![user_message("hi")],
                reasoning_effort: Some("high".into()),
                ..GenerateRequest::default()
            },
        )
        .expect("builds");
        assert_eq!(
            call.body["reasoning"],
            serde_json::json!({ "effort": "high", "summary": "auto" }),
            "the route only streams a reasoning summary when it is asked for one"
        );
    }

    #[test]
    fn the_declared_tools_are_flat_and_the_endpoints_cap_is_the_default() {
        let mut endpoint = base_endpoint();
        endpoint.max_output_tokens = Some(9);
        let request = GenerateRequest {
            endpoint: "codex".into(),
            messages: vec![user_message("hi")],
            tools: vec![crate::types::ToolSpec {
                name: "bash".into(),
                description: "run".into(),
                parameters: serde_json::json!({ "type": "object" }),
            }],
            ..GenerateRequest::default()
        };
        let call = responses_request(&endpoint, &request).expect("builds");
        assert_eq!(
            call.body["tools"],
            serde_json::json!([{
                "type": "function",
                "name": "bash",
                "description": "run",
                "parameters": { "type": "object" }
            }])
        );
        assert_eq!(call.body["max_output_tokens"], serde_json::json!(9));
    }
}
