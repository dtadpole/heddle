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

use futures::StreamExt;
use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, Folded, PreparedCall, StreamFold, fold_sse};
use crate::error::ModelError;
use crate::http::{Method, WireRequest, WireResponse, wire};
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
        let prepared = match anthropic_call(&self.endpoint, &request) {
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
                Ok(WireResponse::Json(_)) => crate::adapter::error_stream(ModelError::new(
                    format!(
                        "'{}' answered the publisher route without a stream",
                        endpoint.name
                    ),
                    endpoint.name.clone(),
                    crate::error::code::BAD_BODY,
                )),
                Ok(WireResponse::Stream { body, .. }) => {
                    fold_sse(body, Box::new(AnthropicFold::new(endpoint.name.clone())))
                }
                Err(error) => crate::adapter::error_stream(error),
            };
            stream
        });
        Box::pin(lazy.flatten())
    }
}

/// The URL, body and headers for the publisher route (`anthropicCall`). `NO_PROJECT`, `NO_REGION` and `NO_MODEL`
/// when the endpoint cannot be addressed.
pub fn anthropic_call(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<PreparedCall, ModelError> {
    let project = endpoint
        .project
        .as_deref()
        .filter(|project| !project.is_empty())
        .ok_or_else(|| {
            ModelError::new(
                format!(
                    "'{}' has no project, and the publisher route is addressed under one",
                    endpoint.name
                ),
                endpoint.name.clone(),
                crate::error::code::NO_PROJECT,
            )
        })?;
    let region = endpoint
        .region
        .as_deref()
        .filter(|region| !region.is_empty())
        .ok_or_else(|| {
            ModelError::new(
                format!(
                    "'{}' has no region, and the publisher route is addressed in one",
                    endpoint.name
                ),
                endpoint.name.clone(),
                crate::error::code::NO_REGION,
            )
        })?;
    let model = request
        .model
        .as_deref()
        .or(endpoint.model.as_deref())
        .filter(|model| !model.is_empty())
        .ok_or_else(|| {
            ModelError::new(
                format!("'{}' names no model", endpoint.name),
                endpoint.name.clone(),
                crate::error::code::NO_MODEL,
            )
        })?;

    // The system prompt is a top-level field, not a message.
    let system = request
        .messages
        .iter()
        .filter(|message| message.role == crate::types::Role::System)
        .map(|message| {
            message
                .content
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>()
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    let mut body = serde_json::Map::new();
    body.insert(
        "anthropic_version".into(),
        Value::String(ANTHROPIC_VERTEX_VERSION.to_string()),
    );
    body.insert(
        "messages".into(),
        Value::Array(to_anthropic_messages(&request.messages)),
    );
    body.insert(
        "max_tokens".into(),
        Value::from(
            request
                .max_output_tokens
                .or(endpoint.max_output_tokens)
                .unwrap_or(DEFAULT_MAX_TOKENS),
        ),
    );
    body.insert("stream".into(), Value::Bool(true));
    if !system.is_empty() {
        body.insert("system".into(), Value::String(system));
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
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.parameters
                        })
                    })
                    .collect(),
            ),
        );
    }
    if let Some(temperature) = request.temperature {
        body.insert(
            "temperature".into(),
            serde_json::Number::from_f64(temperature)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        );
    }
    // The publisher route for these models refuses `thinking.type: enabled`; adaptive thinking plus an effort is
    // the form it names, and `display: explained` is what makes the reasoning visible.
    if let Some(value) = crate::adapter::reasoning_value(endpoint, request)? {
        body.insert(
            "thinking".into(),
            serde_json::json!({ "type": "adaptive", "display": "summarized" }),
        );
        body.insert(
            "output_config".into(),
            serde_json::json!({ "effort": serde_json::to_value(value).unwrap_or(Value::Null) }),
        );
    }

    Ok(PreparedCall {
        url: format!(
            "{}/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:streamRawPredict",
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

/// One message's content (`toAnthropicContent`): text blocks and base64 image blocks.
pub fn to_anthropic_content(parts: &[ContentPart]) -> Vec<Value> {
    let mut content = Vec::new();
    for part in parts {
        match part {
            ContentPart::Text { text } => content.push(serde_json::json!({
                "type": "text",
                "text": text
            })),
            ContentPart::Image(image) => {
                if let Some(data) = &image.data {
                    // A publisher route carries image input as a base64 source block, with no file reference.
                    content.push(serde_json::json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime_type.as_str(),
                            "data": data
                        }
                    }));
                }
            }
            _ => {}
        }
    }
    content
}

/// A tool call's recorded arguments as the provider expects them: parsed JSON, or an empty object.
fn parsed_tool_input(arguments: &str) -> Value {
    serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}))
}

/// The message list as Anthropic reads it (`toAnthropicMessages`), the system prompt left to the top-level field.
pub fn to_anthropic_messages(messages: &[Message]) -> Vec<Value> {
    // Turns must alternate, so adjacent same-role turns are merged in place: a tool result follows an assistant
    // turn directly and is a user turn.
    let mut turns: Vec<(&'static str, Vec<Value>)> = Vec::new();
    let mut push = |role: &'static str, content: Vec<Value>| {
        if content.is_empty() {
            return;
        }
        if let Some((last_role, last_content)) = turns.last_mut()
            && *last_role == role
        {
            last_content.extend(content);
            return;
        }
        turns.push((role, content));
    };

    for message in messages {
        match message.role {
            crate::types::Role::System => continue,
            crate::types::Role::Assistant => {
                let mut content = Vec::new();
                for part in &message.content {
                    match part {
                        ContentPart::Text { text } => content.push(serde_json::json!({
                            "type": "text",
                            "text": text
                        })),
                        ContentPart::ToolCall(call) => content.push(serde_json::json!({
                            "type": "tool_use",
                            "id": call.id,
                            "name": call.name,
                            "input": parsed_tool_input(&call.arguments)
                        })),
                        // Reasoning is deliberately not sent: a thinking block needs the provider's signature.
                        _ => {}
                    }
                }
                push("assistant", content);
            }
            crate::types::Role::Tool => {
                let text = message
                    .content
                    .iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                push(
                    "user",
                    vec![serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                        "content": text
                    })],
                );
            }
            crate::types::Role::User => push("user", to_anthropic_content(&message.content)),
        }
    }
    turns
        .into_iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect()
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

impl AnthropicFold {
    /// The call the provider's block index names, created on first sight.
    fn call(&mut self, index: u32) -> &mut ToolCall {
        if let Some(at) = self.calls.iter().position(|(slot, _)| *slot == index) {
            return &mut self.calls[at].1;
        }
        self.calls.push((
            index,
            ToolCall {
                id: format!("call-{index}"),
                ..ToolCall::default()
            },
        ));
        &mut self.calls.last_mut().expect("just pushed").1
    }

    /// The terminal chunks: every assembled call, then `done`.
    fn finish(&mut self) -> Vec<Chunk> {
        let mut chunks: Vec<Chunk> = self
            .calls
            .iter()
            .map(|(_, call)| Chunk::ToolCall(call.clone()))
            .collect();
        chunks.push(Chunk::Done {
            finish_reason: self.finish_reason.clone(),
            usage: self.usage,
        });
        chunks
    }
}

impl StreamFold for AnthropicFold {
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError> {
        let parsed: Value = match serde_json::from_str(&event.data) {
            Ok(parsed) => parsed,
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
            "message_start" => {
                if let Some(usage) = parsed
                    .get("message")
                    .and_then(|message| message.get("usage"))
                {
                    // The start frame reports only the input side; the cache buckets are not read here, and the
                    // output count arrives with the stop reason.
                    self.usage = Some(crate::usage::TokenUsage {
                        input_tokens: usage.get("input_tokens").and_then(Value::as_u64),
                        output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
                        ..crate::usage::TokenUsage::default()
                    });
                }
            }
            "content_block_start" => {
                let block = parsed.get("content_block");
                let index = parsed.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                if let Some(block) = block
                    && block.get("type").and_then(Value::as_str) == Some("tool_use")
                {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("call-{index}"));
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let call = self.call(index);
                    call.id = id;
                    call.name = name;
                }
            }
            "content_block_delta" => {
                let index = parsed.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                if let Some(delta) = parsed.get("delta") {
                    match delta.get("type").and_then(Value::as_str) {
                        Some("text_delta") => {
                            if let Some(text) = delta.get("text").and_then(Value::as_str) {
                                chunks.push(Chunk::TextDelta {
                                    text: text.to_string(),
                                });
                            }
                        }
                        Some("thinking_delta") => {
                            if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                                chunks.push(Chunk::ReasoningDelta {
                                    text: text.to_string(),
                                });
                            }
                        }
                        Some("input_json_delta") => {
                            let fragment = match delta.get("partial_json") {
                                Some(Value::String(text)) => text.clone(),
                                Some(other) => other.to_string(),
                                None => String::new(),
                            };
                            self.call(index).arguments.push_str(&fragment);
                        }
                        _ => {}
                    }
                }
            }
            "message_delta" => {
                if let Some(stop) = parsed
                    .get("delta")
                    .and_then(|delta| delta.get("stop_reason"))
                    .and_then(Value::as_str)
                {
                    self.finish_reason =
                        crate::types::canonical_finish_reason(Some(stop), self.calls.len());
                }
                if let Some(output) = parsed
                    .get("usage")
                    .and_then(|usage| usage.get("output_tokens"))
                    .and_then(Value::as_u64)
                {
                    let mut usage = self.usage.unwrap_or_default();
                    usage.output_tokens = Some(output);
                    self.usage = Some(usage);
                }
            }
            "message_stop" => {
                let chunks = self.finish();
                return Ok(Folded {
                    chunks,
                    finished: true,
                });
            }
            "error" => {
                let failure = parsed.get("error");
                let kind = failure
                    .and_then(|failure| failure.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("an error");
                let detail = failure
                    .and_then(|failure| failure.get("message"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        serde_json::to_string(&parsed)
                            .unwrap_or_default()
                            .chars()
                            .take(200)
                            .collect()
                    });
                return Err(ModelError::new(
                    format!("'{}' reported {kind} — {detail}", self.endpoint),
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
        self.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::TokenUsage;

    fn sse(event: &str, value: serde_json::Value) -> SseEvent {
        SseEvent {
            event: Some(event.to_string()),
            data: value.to_string(),
        }
    }

    #[test]
    fn text_thinking_and_a_tool_call_fold_into_the_one_vocabulary() {
        let mut fold = AnthropicFold::new("claude");
        let mut chunks = Vec::new();
        for event in [
            sse(
                "message_start",
                serde_json::json!({ "type": "message_start", "message": { "usage": { "input_tokens": 12 } } }),
            ),
            sse(
                "content_block_start",
                serde_json::json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "list_dir" } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "\".\"}" } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "checking" } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "thinking_delta", "thinking": "hm" } }),
            ),
            sse(
                "message_delta",
                serde_json::json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 7 } }),
            ),
        ] {
            chunks.extend(fold.event(&event).expect("folds").chunks);
        }
        assert_eq!(
            chunks,
            vec![
                Chunk::TextDelta {
                    text: "checking".into()
                },
                Chunk::ReasoningDelta { text: "hm".into() },
            ]
        );

        let finished = fold
            .event(&sse(
                "message_stop",
                serde_json::json!({ "type": "message_stop" }),
            ))
            .expect("folds");
        assert!(finished.finished);
        assert_eq!(
            finished.chunks,
            vec![
                Chunk::ToolCall(crate::types::ToolCall {
                    id: "toolu_1".into(),
                    name: "list_dir".into(),
                    arguments: "{\"path\":\".\"}".into(),
                }),
                Chunk::Done {
                    finish_reason: "tool_calls".into(),
                    usage: Some(TokenUsage {
                        input_tokens: Some(12),
                        output_tokens: Some(7),
                        ..TokenUsage::default()
                    }),
                },
            ]
        );
    }

    #[test]
    fn an_ordinary_answers_end_turn_is_the_loops_stop() {
        let mut fold = AnthropicFold::new("claude");
        fold.event(&sse(
            "message_delta",
            serde_json::json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 3 } }),
        ))
        .expect("folds");
        assert_eq!(
            fold.event(&sse(
                "message_stop",
                serde_json::json!({ "type": "message_stop" })
            ))
            .expect("folds")
            .chunks,
            vec![Chunk::Done {
                finish_reason: "stop".into(),
                usage: Some(TokenUsage {
                    input_tokens: None,
                    output_tokens: Some(3),
                    ..TokenUsage::default()
                }),
            }]
        );
    }

    #[test]
    fn a_body_that_ends_without_message_stop_still_finishes_with_the_last_word_it_saw() {
        let mut fold = AnthropicFold::new("claude");
        fold.event(&sse(
            "message_delta",
            serde_json::json!({ "type": "message_delta", "delta": { "stop_reason": "max_tokens" } }),
        ))
        .expect("folds");
        assert_eq!(
            fold.end(),
            vec![Chunk::Done {
                finish_reason: "max_output_tokens".into(),
                usage: None,
            }]
        );
    }

    #[test]
    fn an_error_event_is_remote_and_names_the_endpoint() {
        let error = AnthropicFold::new("claude")
            .event(&sse(
                "error",
                serde_json::json!({ "type": "error", "error": { "type": "overloaded_error", "message": "try again" } }),
            ))
            .expect_err("fails");
        assert_eq!(error.code, crate::error::code::REMOTE);
        assert_eq!(error.endpoint, "claude");
        assert_eq!(
            error.to_string(),
            "'claude' reported overloaded_error — try again"
        );
    }

    #[test]
    fn an_unparseable_frame_is_skipped() {
        let folded = AnthropicFold::new("claude")
            .event(&SseEvent {
                event: None,
                data: "not json".into(),
            })
            .expect("skips");
        assert!(folded.chunks.is_empty());
        assert!(!folded.finished);
    }

    #[test]
    fn content_blocks_are_text_and_base64_images() {
        use crate::types::{ImageMediaType, ImagePart};

        let image = ImagePart {
            name: "shot.png".into(),
            mime_type: ImageMediaType::Jpeg,
            path: "/u/shot.jpg".into(),
            bytes: 3,
            sha256: "ab".into(),
            data: Some("AAAA".into()),
        };
        assert_eq!(
            to_anthropic_content(&[ContentPart::text("look"), ContentPart::Image(image)]),
            vec![
                serde_json::json!({ "type": "text", "text": "look" }),
                serde_json::json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": "image/jpeg", "data": "AAAA" }
                }),
            ]
        );
    }

    #[test]
    fn a_conversation_becomes_alternating_turns_with_tool_blocks_and_no_system_message() {
        let messages = vec![
            Message::new(
                crate::types::Role::System,
                vec![ContentPart::text("be brief")],
            ),
            Message::new(
                crate::types::Role::User,
                vec![ContentPart::text("what is here?")],
            ),
            Message::new(
                crate::types::Role::Assistant,
                vec![
                    ContentPart::text("checking"),
                    ContentPart::reasoning("the user wants a listing"),
                    ContentPart::ToolCall(ToolCall {
                        id: "call-1".into(),
                        name: "list_dir".into(),
                        arguments: r#"{"path":"."}"#.into(),
                    }),
                ],
            ),
            Message {
                role: crate::types::Role::Tool,
                tool_call_id: Some("call-1".into()),
                content: vec![ContentPart::text("AGENTS.md")],
                source: None,
            },
        ];
        let turns = to_anthropic_messages(&messages);
        assert_eq!(
            turns
                .iter()
                .map(|turn| turn["role"].clone())
                .collect::<Vec<_>>(),
            vec![
                serde_json::json!("user"),
                serde_json::json!("assistant"),
                serde_json::json!("user")
            ],
            "the system prompt is not a turn, and the tool result is a user turn"
        );
        assert_eq!(
            turns[1]["content"],
            serde_json::json!([
                { "type": "text", "text": "checking" },
                { "type": "tool_use", "id": "call-1", "name": "list_dir", "input": { "path": "." } }
            ]),
            "a recorded tool call becomes a tool_use block with parsed input"
        );
        assert_eq!(
            turns[2]["content"],
            serde_json::json!([
                { "type": "tool_result", "tool_use_id": "call-1", "content": "AGENTS.md" }
            ])
        );
        // Reasoning is never sent back: a thinking block without the provider's signature is refused.
        let serialized = serde_json::to_string(&turns).expect("serializes");
        assert!(!serialized.contains("the user wants a listing"));
    }

    #[test]
    fn adjacent_turns_of_the_same_role_are_merged_into_one() {
        let messages = vec![
            Message::new(crate::types::Role::User, vec![ContentPart::text("one")]),
            Message::new(crate::types::Role::User, vec![ContentPart::text("two")]),
        ];
        let turns = to_anthropic_messages(&messages);
        assert_eq!(turns.len(), 1);
        assert_eq!(
            turns[0]["content"],
            serde_json::json!([
                { "type": "text", "text": "one" },
                { "type": "text", "text": "two" }
            ])
        );
    }

    fn base_endpoint() -> EndpointConfig {
        EndpointConfig {
            name: "claude".into(),
            kind: heddle_config::EndpointKind::AnthropicVertex,
            base_url: "http://gateway.example:443/v1".into(),
            model: Some("claude-opus-5-5".into()),
            models: None,
            reasoning: None,
            project: Some("a-project".into()),
            region: Some("global".into()),
            api_key: None,
            api_key_file: None,
            headers: Some(std::collections::BTreeMap::from([(
                "x-enterprise-inject".to_string(),
                "descriptor".to_string(),
            )])),
            stream: None,
            max_output_tokens: Some(64),
            context_window: None,
            capabilities: None,
            input_modalities: None,
            proxy: None,
            timeout_ms: None,
        }
    }

    fn request() -> GenerateRequest {
        GenerateRequest {
            endpoint: "claude".into(),
            messages: vec![
                Message::new(
                    crate::types::Role::System,
                    vec![ContentPart::text("be brief")],
                ),
                Message::new(
                    crate::types::Role::User,
                    vec![ContentPart::text("what is here?")],
                ),
            ],
            ..GenerateRequest::default()
        }
    }

    #[test]
    fn the_call_is_addressed_to_the_publisher_route() {
        let call = anthropic_call(&base_endpoint(), &request()).expect("builds");
        assert_eq!(
            call.url,
            "http://gateway.example:443/v1/projects/a-project/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict"
        );
        assert_eq!(
            call.body["anthropic_version"],
            serde_json::json!("vertex-2023-10-16")
        );
        assert_eq!(call.body["stream"], serde_json::json!(true));
        assert_eq!(
            call.body["max_tokens"],
            serde_json::json!(64),
            "the endpoint's cap is the default"
        );
        assert_eq!(call.body["system"], serde_json::json!("be brief"));
        assert_eq!(
            call.headers,
            vec![("X-Enterprise-Inject".to_string(), "descriptor".to_string())],
            "configured headers are Title-Cased for the wire"
        );
    }

    #[test]
    fn a_call_with_no_cap_gets_the_conservative_one_and_the_tool_blocks_are_translated() {
        let mut endpoint = base_endpoint();
        endpoint.max_output_tokens = None;
        let mut request = request();
        request.tools = vec![crate::types::ToolSpec {
            name: "bash".into(),
            description: "run a command".into(),
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
        }];
        let call = anthropic_call(&endpoint, &request).expect("builds");
        assert_eq!(
            call.body["max_tokens"],
            serde_json::json!(DEFAULT_MAX_TOKENS)
        );
        assert_eq!(
            call.body["tools"],
            serde_json::json!([{
                "name": "bash",
                "description": "run a command",
                "input_schema": { "type": "object", "properties": {} }
            }])
        );
    }

    #[test]
    fn a_declared_reasoning_level_opens_adaptive_thinking_with_its_effort() {
        let mut endpoint = base_endpoint();
        endpoint.reasoning = Some(heddle_config::ReasoningLevels {
            default: None,
            levels: vec![heddle_config::ReasoningLevel {
                id: "high".into(),
                name: "High".into(),
                value: Some(heddle_config::ReasoningValue::Text("high".into())),
            }],
        });
        let mut request = request();
        request.reasoning_effort = Some("high".into());
        let call = anthropic_call(&endpoint, &request).expect("builds");
        assert_eq!(
            call.body["thinking"],
            serde_json::json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(
            call.body["output_config"],
            serde_json::json!({ "effort": "high" })
        );
    }

    #[test]
    fn a_missing_project_region_or_model_is_refused_by_name() {
        let mut endpoint = base_endpoint();
        endpoint.project = None;
        let error = anthropic_call(&endpoint, &request()).expect_err("no project");
        assert_eq!(error.code, crate::error::code::NO_PROJECT);

        let mut endpoint = base_endpoint();
        endpoint.region = None;
        let error = anthropic_call(&endpoint, &request()).expect_err("no region");
        assert_eq!(error.code, crate::error::code::NO_REGION);

        let mut endpoint = base_endpoint();
        endpoint.model = None;
        let error = anthropic_call(&endpoint, &request()).expect_err("no model");
        assert_eq!(error.code, crate::error::code::NO_MODEL);
    }
}
