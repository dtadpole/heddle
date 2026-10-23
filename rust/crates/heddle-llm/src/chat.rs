//! OpenAI's Chat Completions shape — the DeepSeek route and every OpenAI-compatible gateway.
//!
//! Ported from `openAiChatAdapter`, `toChatMessage` and `finishFromChatMessage` in `src/llm/adapters.ts`.
//! `POST {base_url_for(model)}/chat/completions`; streams unless the endpoint or request says not to; ends on
//! `[DONE]` or the frame carrying `finish_reason`. Reasoning arrives as `reasoning_content` and becomes
//! [`Chunk::ReasoningDelta`]; tool-call fragments are passed on live as [`Chunk::ToolCallDelta`] and assembled
//! by `index` into one [`Chunk::ToolCall`] each when the round finishes.

use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, Folded, PreparedCall, StreamFold};
use crate::error::ModelError;
use crate::sse::SseEvent;
use crate::types::{Chunk, GenerateRequest, Message};
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
}
