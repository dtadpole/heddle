//! OpenAI's Chat Completions shape — the DeepSeek route and every OpenAI-compatible gateway.
//!
//! Ported from `openAiChatAdapter`, `toChatMessage` and `finishFromChatMessage` in `src/llm/adapters.ts`.
//! `POST {base_url_for(model)}/chat/completions`; streams unless the endpoint or request says not to; ends on
//! `[DONE]` or the frame carrying `finish_reason`. Reasoning arrives as `reasoning_content` and becomes
//! [`Chunk::ReasoningDelta`]; tool-call fragments are passed on live as [`Chunk::ToolCallDelta`] and assembled
//! by `index` into one [`Chunk::ToolCall`] each when the round finishes.

use futures::StreamExt;
use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, Folded, PreparedCall, StreamFold, fold_sse};
use crate::error::ModelError;
use crate::http::{Method, WireRequest, WireResponse, wire};
use crate::sse::SseEvent;
use crate::types::{Chunk, ContentPart, GenerateRequest, Message, Role};
use heddle_config::EndpointConfig;

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
        let prepared = match chat_request(&self.endpoint, &request) {
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
                // A non-streamed answer is reduced to the same chunks.
                Ok(WireResponse::Json(answer)) => Box::pin(futures::stream::iter(
                    chunks_from_chat_json(&answer).into_iter().map(Ok),
                )),
                Ok(WireResponse::Stream { body, .. }) => fold_sse(body, Box::new(ChatFold::new())),
                Err(error) => crate::adapter::error_stream(error),
            };
            stream
        });
        Box::pin(lazy.flatten())
    }
}

/// The request as this route takes it: `model`, `messages`, `tools` (as `{type:'function', function:{…}}`),
/// `max_tokens` (request, else endpoint), `temperature`, `reasoning_effort` (the level's wire value), `stream`
/// (endpoint's force, else request's, else `true`).
pub fn chat_request(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<PreparedCall, ModelError> {
    let streaming = endpoint.stream.or(request.stream).unwrap_or(true);
    let mut body = serde_json::Map::new();
    if let Some(model) = request.model.as_ref().or(endpoint.model.as_ref()) {
        body.insert("model".into(), Value::String(model.clone()));
    }
    let effort = crate::adapter::reasoning_value(endpoint, request)?;
    let reasoning_content = replays_reasoning_content(endpoint, request, effort.is_some());
    body.insert(
        "messages".into(),
        Value::Array(
            request
                .messages
                .iter()
                .map(|message| chat_message(message, reasoning_content))
                .collect(),
        ),
    );
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
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.parameters
                            }
                        })
                    })
                    .collect(),
            ),
        );
    }
    if let Some(max_tokens) = request.max_output_tokens.or(endpoint.max_output_tokens) {
        body.insert("max_tokens".into(), Value::from(max_tokens));
    }
    if let Some(temperature) = request.temperature {
        body.insert(
            "temperature".into(),
            serde_json::Number::from_f64(temperature)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        );
    }
    // Chat Completions names the level `reasoning_effort`; the value is the model's declared wire value.
    if let Some(value) = effort {
        body.insert(
            "reasoning_effort".into(),
            serde_json::to_value(value).unwrap_or(Value::Null),
        );
    }
    body.insert("stream".into(), Value::Bool(streaming));

    Ok(PreparedCall {
        url: format!(
            "{}/chat/completions",
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
        stream: streaming,
    })
}

/// Whether this request's replayed assistant messages carry `reasoning_content` (`replaysReasoningContent`,
/// developer-ten-3).
///
/// DeepSeek's thinking mode refuses a continuation whose replayed assistant message lacks it ("The
/// `reasoning_content` in the thinking mode must be passed back to the API"): a tool-call round, a steer and a
/// subagent's notice all continue a turn that way. DSH's rule, from its OpenAI-completions layer (pi-ai's compat
/// `requiresReasoningContentOnAssistantMessages`, re-read 2026-10-29): auto-detected for a base URL containing
/// `deepseek.com`, applied while reasoning is on — every replayed assistant message carries its thinking text, or
/// `""` when it has none. Reasoning is on when the request names a reasoning level or the history already holds
/// reasoning. Every other chat endpoint is left as it was.
pub fn replays_reasoning_content(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
    effort_named: bool,
) -> bool {
    if !endpoint
        .base_url_for(request.model.as_deref())
        .to_lowercase()
        .contains("deepseek.com")
    {
        return false;
    }
    effort_named
        || request.messages.iter().any(|message| {
            message.role == Role::Assistant
                && message
                    .content
                    .iter()
                    .any(|part| matches!(part, ContentPart::Reasoning { .. }))
        })
}

/// [`to_chat_message`], with a replayed assistant message's `reasoning_content` when `reasoning_content` is set:
/// its thinking, blank blocks dropped and the rest joined by newlines, or `""` (`toChatMessage(message,
/// {reasoningContent})`).
pub fn chat_message(message: &Message, reasoning_content: bool) -> Value {
    let mut value = to_chat_message(message);
    if reasoning_content
        && message.role == Role::Assistant
        && let Value::Object(object) = &mut value
    {
        let thinking = message
            .content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Reasoning { text } if !text.trim().is_empty() => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        object.insert("reasoning_content".into(), Value::String(thinking));
    }
    value
}

/// One message in this shape (`toChatMessage`): text parts joined by `\n` as a string `content` (`null` when there
/// is none); a message with images switches to typed parts with `image_url` data URLs; tool calls become
/// `tool_calls`; a tool result carries `tool_call_id`.
pub fn to_chat_message(message: &Message) -> Value {
    let text = message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        // Separate text blocks are separate blocks on the wire; a newline keeps them apart in this form.
        .collect::<Vec<_>>()
        .join("\n");
    let calls: Vec<&crate::types::ToolCall> = message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::ToolCall(call) => Some(call),
            _ => None,
        })
        .collect();
    let images: Vec<&crate::types::ImagePart> = message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Image(image) if image.data.is_some() => Some(image),
            _ => None,
        })
        .collect();

    let content = if images.is_empty() {
        if text.is_empty() {
            Value::Null
        } else {
            Value::String(text)
        }
    } else {
        // A message carrying images switches to the typed-parts form, the only shape that can carry an
        // `image_url`.
        let mut parts: Vec<Value> = Vec::new();
        if !text.is_empty() {
            parts.push(serde_json::json!({ "type": "text", "text": text }));
        }
        for image in images {
            let data = image.data.as_deref().unwrap_or_default();
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:{};base64,{data}", image.mime_type.as_str())
                }
            }));
        }
        Value::Array(parts)
    };

    let mut object = serde_json::Map::new();
    object.insert(
        "role".into(),
        serde_json::to_value(message.role).unwrap_or(Value::Null),
    );
    object.insert("content".into(), content);
    if !calls.is_empty() {
        object.insert(
            "tool_calls".into(),
            Value::Array(
                calls
                    .iter()
                    .map(|call| {
                        serde_json::json!({
                            "id": call.id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.arguments }
                        })
                    })
                    .collect(),
            ),
        );
    }
    if let Some(tool_call_id) = &message.tool_call_id {
        object.insert("tool_call_id".into(), Value::String(tool_call_id.clone()));
    }
    Value::Object(object)
}

/// A non-streamed answer reduced to the same chunks (`finishFromChatMessage`).
pub fn chunks_from_chat_json(answer: &Value) -> Vec<Chunk> {
    let choice = answer
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let message = choice.and_then(|choice| choice.get("message"));
    let mut chunks = Vec::new();
    if let Some(reasoning) = message
        .and_then(|message| message.get("reasoning_content"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        chunks.push(Chunk::ReasoningDelta {
            text: reasoning.to_string(),
        });
    }
    if let Some(text) = message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        chunks.push(Chunk::TextDelta {
            text: text.to_string(),
        });
    }
    let calls: Vec<&Value> = message
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|calls| calls.iter().collect())
        .unwrap_or_default();
    for call in &calls {
        let function = call.get("function");
        chunks.push(Chunk::ToolCall(crate::types::ToolCall {
            id: call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: function
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: function
                .and_then(|function| function.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }));
    }
    let finish = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str);
    chunks.push(Chunk::Done {
        finish_reason: crate::types::canonical_finish_reason(finish, calls.len()),
        usage: crate::usage::openai_chat_usage(answer.get("usage").unwrap_or(&Value::Null)),
    });
    chunks
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

    /// The call the provider's slot names, created on first sight.
    fn call(&mut self, index: u32) -> &mut crate::types::ToolCall {
        if let Some(at) = self.calls.iter().position(|(slot, _)| *slot == index) {
            return &mut self.calls[at].1;
        }
        self.calls.push((index, crate::types::ToolCall::default()));
        &mut self.calls.last_mut().expect("just pushed").1
    }
}

impl StreamFold for ChatFold {
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError> {
        // `[DONE]` with no finish frame is a plain stop; a finish frame ends the fold before it.
        if event.data == "[DONE]" {
            return Ok(Folded {
                chunks: vec![Chunk::Done {
                    finish_reason: "stop".into(),
                    usage: None,
                }],
                finished: true,
            });
        }
        let parsed: Value = match serde_json::from_str(&event.data) {
            Ok(parsed) => parsed,
            // An unparseable `data:` is skipped, as the TypeScript read loop does.
            Err(_) => return Ok(Folded::default()),
        };
        let mut chunks = Vec::new();
        let choice = parsed
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first());
        if let Some(delta) = choice.and_then(|choice| choice.get("delta")) {
            if let Some(text) = delta
                .get("reasoning_content")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                chunks.push(Chunk::ReasoningDelta {
                    text: text.to_string(),
                });
            }
            if let Some(text) = delta
                .get("content")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                chunks.push(Chunk::TextDelta {
                    text: text.to_string(),
                });
            }
            for fragment in delta
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let index = fragment.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                let id = fragment
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty());
                let function = fragment.get("function");
                let name = function
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty());
                let arguments = function
                    .and_then(|function| function.get("arguments"))
                    .and_then(Value::as_str);
                let call = self.call(index);
                if let Some(id) = id {
                    call.id = id.to_string();
                }
                if let Some(name) = name {
                    call.name = name.to_string();
                }
                if let Some(arguments) = arguments {
                    call.arguments.push_str(arguments);
                }
                // Each fragment is passed on as it lands, so a reader can show the call being written; the
                // assembled `tool-call` still follows when the round finishes.
                chunks.push(Chunk::ToolCallDelta {
                    index,
                    id: id.map(ToString::to_string),
                    name: name.map(ToString::to_string),
                    arguments_delta: arguments.unwrap_or_default().to_string(),
                });
            }
        }
        if let Some(finish) = choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(Value::as_str)
            .filter(|finish| !finish.is_empty())
        {
            for (_, call) in &self.calls {
                let id = if call.id.is_empty() {
                    format!("call-{}", call.name)
                } else {
                    call.id.clone()
                };
                chunks.push(Chunk::ToolCall(crate::types::ToolCall {
                    id,
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                }));
            }
            let usage =
                crate::usage::openai_chat_usage(parsed.get("usage").unwrap_or(&Value::Null));
            chunks.push(Chunk::Done {
                finish_reason: crate::types::canonical_finish_reason(
                    Some(finish),
                    self.calls.len(),
                ),
                usage,
            });
            return Ok(Folded {
                chunks,
                finished: true,
            });
        }
        Ok(Folded {
            chunks,
            finished: false,
        })
    }

    fn end(&mut self) -> Vec<Chunk> {
        vec![Chunk::Done {
            finish_reason: "stop".into(),
            usage: None,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::user_message;
    use crate::usage::TokenUsage;

    fn sse(data: &str) -> SseEvent {
        SseEvent {
            event: None,
            data: data.to_string(),
        }
    }

    fn delta(value: serde_json::Value) -> SseEvent {
        sse(&serde_json::json!({ "choices": [value] }).to_string())
    }

    #[test]
    fn reasoning_and_content_arrive_as_their_own_deltas() {
        let folded = ChatFold::new()
            .event(&delta(serde_json::json!({
                "delta": { "reasoning_content": "hm", "content": "an" }
            })))
            .expect("folds");
        assert_eq!(
            folded.chunks,
            vec![
                Chunk::ReasoningDelta { text: "hm".into() },
                Chunk::TextDelta { text: "an".into() },
            ]
        );
        assert!(!folded.finished);
        // An empty delta is no delta.
        assert!(
            ChatFold::new()
                .event(&delta(serde_json::json!({ "delta": { "content": "" } })))
                .expect("folds")
                .chunks
                .is_empty()
        );
    }

    #[test]
    fn each_tool_call_fragment_is_passed_on_and_the_whole_call_is_assembled_at_the_finish() {
        let mut fold = ChatFold::new();
        let fragments = [
            serde_json::json!({ "index": 0, "id": "call_1", "function": { "name": "write_file", "arguments": "{\"path\":\"" } }),
            serde_json::json!({ "index": 0, "function": { "arguments": "a.txt\"}" } }),
        ];
        let mut deltas = Vec::new();
        for fragment in fragments {
            let folded = fold
                .event(&delta(serde_json::json!({
                    "delta": { "tool_calls": [fragment] },
                    "finish_reason": serde_json::Value::Null
                })))
                .expect("folds");
            deltas.extend(folded.chunks);
        }
        assert_eq!(
            deltas,
            vec![
                Chunk::ToolCallDelta {
                    index: 0,
                    id: Some("call_1".into()),
                    name: Some("write_file".into()),
                    arguments_delta: "{\"path\":\"".into(),
                },
                Chunk::ToolCallDelta {
                    index: 0,
                    id: None,
                    name: None,
                    arguments_delta: "a.txt\"}".into(),
                },
            ],
            "each fragment reaches the caller as it lands"
        );

        let folded = fold
            .event(&delta(serde_json::json!({
                "delta": {},
                "finish_reason": "tool_calls"
            })))
            .expect("folds");
        assert_eq!(
            folded.chunks,
            vec![
                Chunk::ToolCall(crate::types::ToolCall {
                    id: "call_1".into(),
                    name: "write_file".into(),
                    arguments: "{\"path\":\"a.txt\"}".into(),
                }),
                Chunk::Done {
                    finish_reason: "tool_calls".into(),
                    usage: None,
                },
            ]
        );
        assert!(folded.finished);
    }

    #[test]
    fn the_finish_frame_carries_the_usage_and_the_loop_word_for_the_provider_word() {
        let folded = ChatFold::new()
            .event(&delta(serde_json::json!({
                "delta": {},
                "finish_reason": "length"
            })))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            folded.chunks,
            vec![Chunk::Done {
                finish_reason: "max_output_tokens".into(),
                usage: None,
            }]
        );

        let with_usage = ChatFold::new()
            .event(&sse(&serde_json::json!({
                "choices": [{ "delta": {}, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 4 }
            })
            .to_string()))
            .expect("folds");
        assert_eq!(
            with_usage.chunks,
            vec![Chunk::Done {
                finish_reason: "stop".into(),
                usage: Some(TokenUsage {
                    input_tokens: Some(10),
                    output_tokens: Some(4),
                    ..TokenUsage::default()
                }),
            }]
        );
    }

    #[test]
    fn a_done_sentinel_with_no_finish_frame_is_a_plain_stop() {
        let folded = ChatFold::new().event(&sse("[DONE]")).expect("folds");
        assert!(folded.finished);
        assert_eq!(
            folded.chunks,
            vec![Chunk::Done {
                finish_reason: "stop".into(),
                usage: None,
            }]
        );
    }

    #[test]
    fn a_body_that_ends_without_a_finish_frame_finishes_stop_and_an_unparseable_frame_is_skipped() {
        assert_eq!(
            ChatFold::new().end(),
            vec![Chunk::Done {
                finish_reason: "stop".into(),
                usage: None,
            }]
        );
        let folded = ChatFold::new().event(&sse("not json")).expect("skips");
        assert!(folded.chunks.is_empty());
        assert!(!folded.finished);
    }

    #[test]
    fn a_text_only_message_keeps_the_string_content_and_joins_its_text_blocks() {
        use crate::types::Role;

        let message = Message::new(
            Role::User,
            vec![ContentPart::text("one"), ContentPart::text("two")],
        );
        assert_eq!(
            to_chat_message(&message),
            serde_json::json!({ "role": "user", "content": "one\ntwo" })
        );
        // A message with nothing to say carries `null`, not an empty string.
        assert_eq!(
            to_chat_message(&Message::new(Role::Assistant, Vec::new())),
            serde_json::json!({ "role": "assistant", "content": null })
        );
        // Reasoning contributes no text, because it is not replayed.
        assert_eq!(
            to_chat_message(&Message::new(
                Role::Assistant,
                vec![ContentPart::reasoning("hm")]
            )),
            serde_json::json!({ "role": "assistant", "content": null })
        );
    }

    #[test]
    fn a_message_with_an_image_switches_to_typed_parts_with_a_data_url() {
        use crate::types::{ImageMediaType, ImagePart, Role};

        let image = ImagePart {
            name: "shot.png".into(),
            mime_type: ImageMediaType::Png,
            path: "/u/shot.png".into(),
            bytes: 3,
            sha256: "ab".into(),
            data: Some("AAAA".into()),
        };
        let message = Message::new(
            Role::User,
            vec![ContentPart::text("look"), ContentPart::Image(image)],
        );
        assert_eq!(
            to_chat_message(&message),
            serde_json::json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "look" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
                ]
            })
        );
        // An image that never got its bytes (the recorded reference alone) is not sent as one.
        let recorded = ImagePart {
            name: "shot.png".into(),
            mime_type: ImageMediaType::Png,
            path: "/u/shot.png".into(),
            bytes: 3,
            sha256: "ab".into(),
            data: None,
        };
        assert_eq!(
            to_chat_message(&Message::new(
                Role::User,
                vec![ContentPart::Image(recorded)]
            )),
            serde_json::json!({ "role": "user", "content": null })
        );
    }

    #[test]
    fn a_tool_call_and_a_tool_result_keep_their_identity() {
        use crate::types::{Role, ToolCall};

        let assistant = Message::new(
            Role::Assistant,
            vec![
                ContentPart::text("checking"),
                ContentPart::ToolCall(ToolCall {
                    id: "call-1".into(),
                    name: "bash".into(),
                    arguments: "{}".into(),
                }),
            ],
        );
        assert_eq!(
            to_chat_message(&assistant),
            serde_json::json!({
                "role": "assistant",
                "content": "checking",
                "tool_calls": [
                    { "id": "call-1", "type": "function", "function": { "name": "bash", "arguments": "{}" } }
                ]
            })
        );
        let result = Message {
            role: Role::Tool,
            tool_call_id: Some("call-1".into()),
            content: vec![ContentPart::text("hi")],
            source: None,
        };
        assert_eq!(
            to_chat_message(&result),
            serde_json::json!({
                "role": "tool",
                "content": "hi",
                "tool_call_id": "call-1"
            })
        );
    }

    #[test]
    fn a_non_streamed_answer_reduces_to_the_same_chunks() {
        let answer = serde_json::json!({
            "choices": [{
                "message": {
                    "reasoning_content": "hm",
                    "content": "ok",
                    "tool_calls": [{ "id": "c1", "function": { "name": "bash", "arguments": "{}" } }]
                },
                "finish_reason": "length"
            }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 2 }
        });
        assert_eq!(
            chunks_from_chat_json(&answer),
            vec![
                Chunk::ReasoningDelta { text: "hm".into() },
                Chunk::TextDelta { text: "ok".into() },
                Chunk::ToolCall(crate::types::ToolCall {
                    id: "c1".into(),
                    name: "bash".into(),
                    arguments: "{}".into(),
                }),
                Chunk::Done {
                    finish_reason: "max_output_tokens".into(),
                    usage: Some(crate::usage::TokenUsage {
                        input_tokens: Some(3),
                        output_tokens: Some(2),
                        ..crate::usage::TokenUsage::default()
                    }),
                },
            ]
        );
    }

    fn base_endpoint() -> EndpointConfig {
        EndpointConfig {
            name: "chat".into(),
            kind: heddle_config::EndpointKind::OpenaiChat,
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
    fn the_request_is_the_body_this_route_takes() {
        let request = GenerateRequest {
            endpoint: "chat".into(),
            messages: vec![user_message("hi")],
            tools: vec![crate::types::ToolSpec {
                name: "bash".into(),
                description: "run a command".into(),
                parameters: serde_json::json!({ "type": "object", "properties": {} }),
            }],
            max_output_tokens: Some(64),
            temperature: Some(0.2),
            ..GenerateRequest::default()
        };
        let call = chat_request(&base_endpoint(), &request).expect("builds");
        assert_eq!(call.url, "http://gateway.example/v1/chat/completions");
        assert!(call.stream, "a call streams unless it is told not to");
        assert_eq!(call.body["model"], serde_json::json!("m"));
        assert_eq!(
            call.body["messages"],
            serde_json::json!([{ "role": "user", "content": "hi" }])
        );
        assert_eq!(
            call.body["tools"],
            serde_json::json!([{
                "type": "function",
                "function": {
                    "name": "bash",
                    "description": "run a command",
                    "parameters": { "type": "object", "properties": {} }
                }
            }])
        );
        assert_eq!(call.body["max_tokens"], serde_json::json!(64));
        assert_eq!(call.body["temperature"], serde_json::json!(0.2));
        assert_eq!(call.body["stream"], serde_json::json!(true));
    }

    #[test]
    fn the_requests_model_wins_and_its_own_gateway_is_the_address() {
        let mut endpoint = base_endpoint();
        endpoint.models = Some(vec![heddle_config::ModelEntry::Option(
            heddle_config::ModelOption {
                id: "other".into(),
                base_url: Some("http://other.example/v2".into()),
                ..heddle_config::ModelOption::default()
            },
        )]);
        let call = chat_request(
            &endpoint,
            &GenerateRequest {
                endpoint: "chat".into(),
                messages: vec![user_message("hi")],
                model: Some("other".into()),
                ..GenerateRequest::default()
            },
        )
        .expect("builds");
        assert_eq!(call.url, "http://other.example/v2/chat/completions");
        assert_eq!(call.body["model"], serde_json::json!("other"));
    }

    #[test]
    fn the_streaming_flag_follows_the_endpoint_then_the_request_then_true() {
        let mut endpoint = base_endpoint();
        endpoint.stream = Some(false);
        let request = GenerateRequest {
            endpoint: "chat".into(),
            messages: vec![user_message("hi")],
            ..GenerateRequest::default()
        };
        let call = chat_request(&endpoint, &request).expect("builds");
        assert!(!call.stream);
        assert_eq!(call.body["stream"], serde_json::json!(false));

        let mut endpoint = base_endpoint();
        endpoint.stream = None;
        let request = GenerateRequest {
            stream: Some(false),
            ..request
        };
        assert!(!chat_request(&endpoint, &request).expect("builds").stream);

        let call = chat_request(
            &endpoint,
            &GenerateRequest {
                endpoint: "chat".into(),
                messages: vec![user_message("hi")],
                ..GenerateRequest::default()
            },
        )
        .expect("builds");
        assert!(call.stream);
    }

    fn thinking_message() -> Message {
        Message::new(
            Role::Assistant,
            vec![
                ContentPart::Reasoning {
                    text: "count up".into(),
                },
                ContentPart::Reasoning { text: "   ".into() },
                ContentPart::Reasoning {
                    text: "from one".into(),
                },
                ContentPart::text("1 2 3"),
            ],
        )
    }

    #[test]
    fn a_replayed_assistant_message_carries_its_thinking_or_empty_only_when_asked() {
        let thinking = thinking_message();
        let plain = Message::new(Role::Assistant, vec![ContentPart::text("done")]);
        let user = user_message("STEER: stop");
        assert_eq!(
            chat_message(&thinking, true)["reasoning_content"],
            serde_json::json!("count up\nfrom one"),
            "blank blocks dropped"
        );
        assert_eq!(
            chat_message(&plain, true)["reasoning_content"],
            serde_json::json!(""),
            "no thinking is \"\""
        );
        assert!(chat_message(&user, true).get("reasoning_content").is_none());
        assert!(
            chat_message(&thinking, false)
                .get("reasoning_content")
                .is_none(),
            "off, as every other endpoint keeps it"
        );
        assert_eq!(
            chat_message(&thinking, true)["content"],
            serde_json::json!("1 2 3")
        );
    }

    #[test]
    fn only_a_deepseek_base_url_with_reasoning_on_replays_reasoning_content() {
        let mut deepseek = base_endpoint();
        deepseek.base_url = "https://api.deepseek.com/v1".into();
        let other = base_endpoint();
        let user = user_message("go");
        let quiet = GenerateRequest {
            endpoint: "chat".into(),
            messages: vec![
                user.clone(),
                Message::new(Role::Assistant, vec![ContentPart::text("done")]),
                user.clone(),
            ],
            ..GenerateRequest::default()
        };
        let thought = GenerateRequest {
            endpoint: "chat".into(),
            messages: vec![user.clone(), thinking_message(), user.clone()],
            ..GenerateRequest::default()
        };
        assert!(replays_reasoning_content(&deepseek, &quiet, true));
        assert!(replays_reasoning_content(&deepseek, &thought, false));
        assert!(!replays_reasoning_content(&deepseek, &quiet, false));
        assert!(!replays_reasoning_content(&other, &thought, true));

        let call = chat_request(&deepseek, &thought).expect("builds");
        let assistants: Vec<&Value> = call.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "assistant")
            .collect();
        assert_eq!(
            assistants[0]["reasoning_content"],
            serde_json::json!("count up\nfrom one")
        );
        let plain = chat_request(&other, &thought).expect("builds");
        assert!(
            plain.body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|message| message.get("reasoning_content").is_none()),
            "another endpoint receives no reasoning_content"
        );
    }

    #[test]
    fn a_reasoning_level_the_model_declares_goes_out_as_its_wire_value() {
        let mut endpoint = base_endpoint();
        endpoint.reasoning = Some(heddle_config::ReasoningLevels {
            default: None,
            levels: vec![heddle_config::ReasoningLevel {
                id: "high".into(),
                name: "High".into(),
                value: Some(heddle_config::ReasoningValue::Text("high".into())),
            }],
        });
        let call = chat_request(
            &endpoint,
            &GenerateRequest {
                endpoint: "chat".into(),
                messages: vec![user_message("hi")],
                reasoning_effort: Some("high".into()),
                ..GenerateRequest::default()
            },
        )
        .expect("builds");
        assert_eq!(call.body["reasoning_effort"], serde_json::json!("high"));
    }
}
