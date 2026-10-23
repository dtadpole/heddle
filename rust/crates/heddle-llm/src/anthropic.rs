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
}
