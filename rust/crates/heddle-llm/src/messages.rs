//! Anthropic's own Messages API: `POST {base_url}/messages`.
//!
//! Ported from `ANTHROPIC_MESSAGES_VERSION`, `anthropicThinking`, `anthropicMessagesCall`, `anthropicMessageChunks` and
//! `anthropicMessagesAdapter` in `src/llm/adapters.ts`. The kind is configured as `anthropic-messages`, which
//! `heddle-config` keeps as [`heddle_config::EndpointKind::Other`] — the reader carries every kind as a string and this
//! crate decides which ones it speaks ([`crate::adapter::adapter_for`]).
//!
//! It is a separate kind from the publisher route ([`crate::anthropic`]) for a measured reason: a gateway may serve
//! Claude on its Chat Completions route **buffered** — the Conclave gateway answered a 30-line count there as one
//! content chunk, and as 21 text deltas on `/v1/messages` (2026-10-29). The conversation translation and the event fold
//! are the publisher route's ([`crate::anthropic::to_anthropic_messages`], [`crate::anthropic::AnthropicFold`], with
//! live tool-call fragments on); what differs is the envelope — the model in the body, the version
//! ([`ANTHROPIC_MESSAGES_VERSION`]) and the credential (`x-api-key`) in headers — and the thinking a level asks for
//! ([`anthropic_thinking`]).

use futures::StreamExt;
use serde_json::Value;

use crate::adapter::{Adapter, ChunkStream, PreparedCall, fold_sse};
use crate::anthropic::{
    AnthropicFold, DEFAULT_MAX_TOKENS, anthropic_system, to_anthropic_messages,
};
use crate::error::ModelError;
use crate::http::{Method, WireRequest, WireResponse, wire};
use crate::types::{Chunk, GenerateRequest, ToolCall};
use heddle_config::{EndpointConfig, ReasoningValue};

/// The kind as configuration spells it.
pub const ANTHROPIC_MESSAGES: &str = "anthropic-messages";

/// The API version the Messages route requires, sent as the `anthropic-version` header. A configured header of the
/// same name wins, which is how an endpoint pins a newer version.
pub const ANTHROPIC_MESSAGES_VERSION: &str = "2023-06-01";

/// Whether an endpoint's kind is this one.
pub fn is_anthropic_messages(kind: &heddle_config::EndpointKind) -> bool {
    matches!(kind, heddle_config::EndpointKind::Other(name) if name == ANTHROPIC_MESSAGES)
}

/// The thinking a declared level asks for, in the form its value names (`anthropicThinking`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Thinking {
    /// The `thinking` field, when the level sends one.
    pub thinking: Option<Value>,
    /// The `output_config` field: an adaptive level's effort.
    pub output_config: Option<Value>,
    /// A budget level's token budget, which the cap must exceed.
    pub budget: Option<u64>,
}

/// The thinking a level's value asks for on the Messages route.
///
/// A **string** is an effort: `thinking: {type: "adaptive", display: "summarized"}` plus `output_config.effort` — the
/// only form the newest Opus model takes. A **number** is a token budget: `thinking: {type: "enabled", budget_tokens,
/// display: "summarized"}` — the only form `claude-sonnet-4-5` takes ("adaptive thinking is not supported on this
/// model"). `display: "summarized"` is what makes the thinking visible: without it the route streamed one empty
/// `thinking_delta`. `None` (no level, or a level whose value is null) sends nothing.
pub fn anthropic_thinking(value: Option<&ReasoningValue>) -> Thinking {
    match value {
        None => Thinking::default(),
        Some(ReasoningValue::Text(effort)) => Thinking {
            thinking: Some(serde_json::json!({ "type": "adaptive", "display": "summarized" })),
            output_config: Some(serde_json::json!({ "effort": effort })),
            budget: None,
        },
        Some(ReasoningValue::Number(number)) => Thinking {
            thinking: Some(serde_json::json!({
                "type": "enabled",
                "budget_tokens": number,
                "display": "summarized"
            })),
            output_config: None,
            budget: number
                .as_u64()
                .or_else(|| number.as_f64().map(|budget| budget.max(0.0).round() as u64)),
        },
    }
}

/// The URL, body and headers for the Messages route (`anthropicMessagesCall`). `NO_MODEL` when neither the request
/// nor the endpoint names a model.
///
/// **Key-free**: the adapter adds `x-api-key` when it sends, so nothing that prints a prepared call can print a key.
/// Rules that are each a refusal from the route when wrong: the cap must exceed a thinking budget (a cap at or below
/// it is raised by the budget, so the caller's number stays room for the answer); no `temperature` beside thinking
/// (the route takes only 1 then); reasoning is never replayed (measured: a second tool round with no thinking block
/// is answered normally in both forms). `stream: false` on the endpoint asks for one JSON message.
pub fn anthropic_messages_call(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<PreparedCall, ModelError> {
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
    let system = anthropic_system(&request.messages);
    let thinking = anthropic_thinking(crate::adapter::reasoning_value(endpoint, request)?.as_ref());
    let cap = request
        .max_output_tokens
        .or(endpoint.max_output_tokens)
        .unwrap_or(DEFAULT_MAX_TOKENS);
    let max_tokens = match thinking.budget {
        Some(budget) if cap <= budget => budget + cap,
        _ => cap,
    };
    let streaming = endpoint.stream.or(request.stream).unwrap_or(true);

    let mut body = serde_json::Map::new();
    body.insert("model".into(), Value::String(model.to_string()));
    body.insert(
        "messages".into(),
        Value::Array(to_anthropic_messages(&request.messages)),
    );
    body.insert("max_tokens".into(), Value::from(max_tokens));
    body.insert("stream".into(), Value::Bool(streaming));
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
    if let Some(temperature) = request.temperature
        && thinking.thinking.is_none()
    {
        body.insert(
            "temperature".into(),
            serde_json::Number::from_f64(temperature)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        );
    }
    if let Some(value) = thinking.thinking {
        body.insert("thinking".into(), value);
    }
    if let Some(value) = thinking.output_config {
        body.insert("output_config".into(), value);
    }

    // The version first, then the configured headers, a configured name replacing the default of the same name.
    let mut headers = vec![(
        "anthropic-version".to_string(),
        ANTHROPIC_MESSAGES_VERSION.to_string(),
    )];
    for (name, value) in endpoint.headers.iter().flatten() {
        match headers
            .iter_mut()
            .find(|(known, _)| known.eq_ignore_ascii_case(name))
        {
            Some(slot) => slot.1 = value.clone(),
            None => headers.push((name.clone(), value.clone())),
        }
    }

    Ok(PreparedCall {
        url: format!(
            "{}/messages",
            endpoint.base_url_for(request.model.as_deref())
        ),
        body: Value::Object(body),
        headers: crate::http::title_case_headers(&headers),
        stream: streaming,
    })
}

/// One non-streamed Messages answer as the chunks a stream folds into (`anthropicMessageChunks`): a `thinking` block is
/// reasoning, a `text` block text, a `tool_use` block a finished call whose `input` is already parsed JSON.
pub fn anthropic_message_chunks(json: &Value) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut calls = 0usize;
    for block in json
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match block.get("type").and_then(Value::as_str) {
            Some("thinking") => {
                if let Some(text) = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    chunks.push(Chunk::ReasoningDelta {
                        text: text.to_string(),
                    });
                }
            }
            Some("text") => {
                if let Some(text) = block
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    chunks.push(Chunk::TextDelta {
                        text: text.to_string(),
                    });
                }
            }
            Some("tool_use") => {
                calls += 1;
                chunks.push(Chunk::ToolCall(ToolCall {
                    id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("call-{}", calls - 1)),
                    name: block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    arguments: serde_json::to_string(
                        block.get("input").unwrap_or(&serde_json::json!({})),
                    )
                    .unwrap_or_else(|_| "{}".to_string()),
                }));
            }
            _ => {}
        }
    }
    chunks.push(Chunk::Done {
        finish_reason: crate::types::canonical_finish_reason(
            json.get("stop_reason").and_then(Value::as_str),
            calls,
        ),
        usage: json.get("usage").and_then(crate::usage::anthropic_usage),
    });
    chunks
}

/// The Messages-route adapter for one endpoint (`anthropicMessagesAdapter`).
#[derive(Debug, Clone)]
pub struct AnthropicMessagesAdapter {
    endpoint: EndpointConfig,
}

impl AnthropicMessagesAdapter {
    pub fn new(endpoint: EndpointConfig) -> Self {
        Self { endpoint }
    }
}

impl Adapter for AnthropicMessagesAdapter {
    fn endpoint(&self) -> &EndpointConfig {
        &self.endpoint
    }

    fn stream(&self, request: GenerateRequest) -> ChunkStream {
        let prepared = match anthropic_messages_call(&self.endpoint, &request) {
            Ok(prepared) => prepared,
            Err(error) => return crate::adapter::error_stream(error),
        };
        let endpoint = self.endpoint.clone();
        let lazy = futures::stream::once(async move {
            let mut headers = prepared.headers;
            // Anthropic's header, never a bearer token: the credential is added here, not in the prepared call.
            if let Some(key) = endpoint.api_key.clone() {
                headers.retain(|(name, _)| !name.eq_ignore_ascii_case("x-api-key"));
                headers.push(("X-Api-Key".to_string(), key));
            }
            let call = WireRequest {
                url: prepared.url,
                method: Method::Post,
                body: Some(prepared.body),
                headers,
                api_key: None,
                stream: prepared.stream,
                timeout_ms: endpoint.timeout_ms,
                endpoint: endpoint.name.clone(),
                proxy: endpoint.proxy.clone(),
            };
            let stream: ChunkStream = match wire(call).await {
                Ok(WireResponse::Json(json)) => Box::pin(futures::stream::iter(
                    anthropic_message_chunks(&json)
                        .into_iter()
                        .map(Ok::<Chunk, ModelError>),
                )),
                Ok(WireResponse::Stream { body, .. }) => fold_sse(
                    body,
                    Box::new(AnthropicFold::new(endpoint.name.clone()).with_live_tool_calls()),
                ),
                Err(error) => crate::adapter::error_stream(error),
            };
            stream
        });
        Box::pin(lazy.flatten())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::StreamFold;
    use crate::sse::SseEvent;
    use crate::types::{ContentPart, Message, Role, ToolSpec};
    use crate::usage::TokenUsage;
    use heddle_config::{EndpointKind, ReasoningLevel, ReasoningLevels};

    fn endpoint() -> EndpointConfig {
        EndpointConfig {
            name: "claude".into(),
            kind: EndpointKind::Other(ANTHROPIC_MESSAGES.into()),
            base_url: "http://gateway.example:8088/v1".into(),
            model: Some("claude-model".into()),
            models: None,
            reasoning: Some(ReasoningLevels {
                default: Some("high".into()),
                levels: vec![
                    ReasoningLevel {
                        id: "default".into(),
                        name: "Default".into(),
                        value: None,
                    },
                    ReasoningLevel {
                        id: "high".into(),
                        name: "High".into(),
                        value: Some(ReasoningValue::Text("high".into())),
                    },
                    ReasoningLevel {
                        id: "budget".into(),
                        name: "Budget".into(),
                        value: Some(ReasoningValue::Number(serde_json::Number::from(2048))),
                    },
                ],
            }),
            project: None,
            region: None,
            api_key: Some("sk-secret-never-printed".into()),
            api_key_file: None,
            headers: Some(std::collections::BTreeMap::from([(
                "x-gateway-inject".to_string(),
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
                Message::new(Role::System, vec![ContentPart::text("be brief")]),
                Message::new(Role::User, vec![ContentPart::text("what is here?")]),
                Message::new(
                    Role::Assistant,
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
                    role: Role::Tool,
                    tool_call_id: Some("call-1".into()),
                    content: vec![ContentPart::text("AGENTS.md")],
                    source: None,
                },
            ],
            ..GenerateRequest::default()
        }
    }

    fn with_effort(effort: &str) -> GenerateRequest {
        GenerateRequest {
            reasoning_effort: Some(effort.into()),
            ..request()
        }
    }

    #[test]
    fn the_kind_is_recognised_by_its_configured_name_only() {
        assert!(is_anthropic_messages(&EndpointKind::Other(
            "anthropic-messages".into()
        )));
        assert!(!is_anthropic_messages(&EndpointKind::AnthropicVertex));
        assert!(!is_anthropic_messages(&EndpointKind::Other(
            "mystery".into()
        )));
        assert_eq!(
            EndpointKind::parse("anthropic-messages").as_str(),
            ANTHROPIC_MESSAGES,
            "the reader keeps the spelling, so listing and dispatch agree"
        );
    }

    #[test]
    fn the_call_goes_to_messages_with_the_model_in_the_body_and_the_version_in_a_header() {
        let call = anthropic_messages_call(&endpoint(), &request()).expect("builds");
        assert_eq!(call.url, "http://gateway.example:8088/v1/messages");
        assert_eq!(call.body["model"], serde_json::json!("claude-model"));
        assert_eq!(call.body["stream"], serde_json::json!(true));
        assert!(call.stream);
        assert_eq!(call.body["max_tokens"], serde_json::json!(64));
        assert!(
            call.body.get("anthropic_version").is_none(),
            "the body version is the publisher route's rule"
        );
        assert_eq!(
            call.headers,
            vec![
                ("Anthropic-Version".to_string(), "2023-06-01".to_string()),
                ("X-Gateway-Inject".to_string(), "descriptor".to_string()),
            ]
        );
    }

    #[test]
    fn the_prepared_call_never_carries_the_credential() {
        let call = anthropic_messages_call(&endpoint(), &request()).expect("builds");
        let printed = format!("{call:?}");
        assert!(!printed.contains("sk-secret-never-printed"), "{printed}");
    }

    #[test]
    fn a_configured_header_of_the_same_name_pins_a_different_version() {
        let mut endpoint = endpoint();
        endpoint.headers = Some(std::collections::BTreeMap::from([(
            "Anthropic-Version".to_string(),
            "2099-01-01".to_string(),
        )]));
        let call = anthropic_messages_call(&endpoint, &request()).expect("builds");
        assert_eq!(
            call.headers,
            vec![("Anthropic-Version".to_string(), "2099-01-01".to_string())]
        );
    }

    #[test]
    fn the_request_names_the_model_per_call_and_an_endpoint_with_none_is_refused() {
        let named = GenerateRequest {
            model: Some("claude-sonnet-4-5".into()),
            ..request()
        };
        assert_eq!(
            anthropic_messages_call(&endpoint(), &named)
                .expect("builds")
                .body["model"],
            serde_json::json!("claude-sonnet-4-5")
        );
        let mut unnamed = endpoint();
        unnamed.model = None;
        let error = anthropic_messages_call(&unnamed, &request()).expect_err("no model");
        assert_eq!(error.code, crate::error::code::NO_MODEL);
    }

    #[test]
    fn the_conversation_is_translated_as_anthropic_reads_it_and_reasoning_is_not_replayed() {
        let call = anthropic_messages_call(&endpoint(), &request()).expect("builds");
        assert_eq!(call.body["system"], serde_json::json!("be brief"));
        assert_eq!(
            call.body["messages"],
            serde_json::json!([
                { "role": "user", "content": [{ "type": "text", "text": "what is here?" }] },
                { "role": "assistant", "content": [
                    { "type": "text", "text": "checking" },
                    { "type": "tool_use", "id": "call-1", "name": "list_dir", "input": { "path": "." } }
                ] },
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "call-1", "content": "AGENTS.md" }
                ] }
            ])
        );
        assert!(!call.body.to_string().contains("the user wants a listing"));
    }

    #[test]
    fn tools_are_declared_with_an_input_schema() {
        let mut request = request();
        request.tools = vec![ToolSpec {
            name: "bash".into(),
            description: "run a command".into(),
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
        }];
        let call = anthropic_messages_call(&endpoint(), &request).expect("builds");
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
    fn an_effort_level_asks_for_adaptive_summarized_thinking_with_that_effort() {
        let call = anthropic_messages_call(&endpoint(), &with_effort("high")).expect("builds");
        assert_eq!(
            call.body["thinking"],
            serde_json::json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(
            call.body["output_config"],
            serde_json::json!({ "effort": "high" })
        );
        assert_eq!(call.body["max_tokens"], serde_json::json!(64));
    }

    #[test]
    fn a_budget_level_asks_for_enabled_thinking_and_the_cap_leaves_room_for_the_answer() {
        let call = anthropic_messages_call(&endpoint(), &with_effort("budget")).expect("builds");
        assert_eq!(
            call.body["thinking"],
            serde_json::json!({ "type": "enabled", "budget_tokens": 2048, "display": "summarized" })
        );
        assert!(call.body.get("output_config").is_none());
        assert_eq!(call.body["max_tokens"], serde_json::json!(2048 + 64));

        let mut roomy = endpoint();
        roomy.max_output_tokens = Some(8192);
        let call = anthropic_messages_call(&roomy, &with_effort("budget")).expect("builds");
        assert_eq!(call.body["max_tokens"], serde_json::json!(8192));

        let mut unset = endpoint();
        unset.max_output_tokens = None;
        let call = anthropic_messages_call(&unset, &with_effort("budget")).expect("builds");
        assert_eq!(
            call.body["max_tokens"],
            serde_json::json!(DEFAULT_MAX_TOKENS)
        );
    }

    #[test]
    fn a_null_level_sends_nothing_and_an_undeclared_one_is_refused_loudly() {
        let quiet = anthropic_messages_call(&endpoint(), &with_effort("default")).expect("builds");
        assert!(quiet.body.get("thinking").is_none());
        assert!(quiet.body.get("output_config").is_none());
        let error =
            anthropic_messages_call(&endpoint(), &with_effort("ultra")).expect_err("undeclared");
        assert_eq!(error.code, crate::error::code::UNSUPPORTED_REASONING_EFFORT);
        assert!(
            error.to_string().contains("default, high, budget"),
            "{error}"
        );
    }

    #[test]
    fn a_temperature_is_sent_without_thinking_and_dropped_beside_it() {
        let mut plain = request();
        plain.temperature = Some(0.25);
        assert_eq!(
            anthropic_messages_call(&endpoint(), &plain)
                .expect("builds")
                .body["temperature"],
            serde_json::json!(0.25)
        );
        let mut thinking = with_effort("high");
        thinking.temperature = Some(0.25);
        assert!(
            anthropic_messages_call(&endpoint(), &thinking)
                .expect("builds")
                .body
                .get("temperature")
                .is_none()
        );
    }

    #[test]
    fn the_thinking_form_follows_the_value() {
        assert_eq!(
            anthropic_thinking(Some(&ReasoningValue::Text("max".into()))),
            Thinking {
                thinking: Some(serde_json::json!({ "type": "adaptive", "display": "summarized" })),
                output_config: Some(serde_json::json!({ "effort": "max" })),
                budget: None,
            }
        );
        assert_eq!(
            anthropic_thinking(Some(&ReasoningValue::Number(serde_json::Number::from(
                4096
            )))),
            Thinking {
                thinking: Some(serde_json::json!({
                    "type": "enabled", "budget_tokens": 4096, "display": "summarized"
                })),
                output_config: None,
                budget: Some(4096),
            }
        );
        assert_eq!(anthropic_thinking(None), Thinking::default());
    }

    #[test]
    fn an_endpoint_with_streaming_off_asks_for_one_json_message() {
        let mut endpoint = endpoint();
        endpoint.stream = Some(false);
        let call = anthropic_messages_call(&endpoint, &request()).expect("builds");
        assert_eq!(call.body["stream"], serde_json::json!(false));
        assert!(!call.stream);
    }

    #[test]
    fn a_json_answer_folds_into_the_same_chunks_as_a_stream() {
        let chunks = anthropic_message_chunks(&serde_json::json!({
            "type": "message",
            "content": [
                { "type": "thinking", "thinking": "weighing it", "signature": "sig" },
                { "type": "text", "text": "calling" },
                { "type": "tool_use", "id": "toolu_1", "name": "probe_echo", "input": { "value": "hello" } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 383, "output_tokens": 50, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 }
        }));
        assert_eq!(
            chunks[..3],
            [
                Chunk::ReasoningDelta {
                    text: "weighing it".into()
                },
                Chunk::TextDelta {
                    text: "calling".into()
                },
                Chunk::ToolCall(ToolCall {
                    id: "toolu_1".into(),
                    name: "probe_echo".into(),
                    arguments: r#"{"value":"hello"}"#.into(),
                }),
            ]
        );
        match &chunks[3] {
            Chunk::Done {
                finish_reason,
                usage,
            } => {
                assert_eq!(finish_reason, "tool_calls");
                let usage = usage.expect("reported");
                assert_eq!(usage.input_tokens, Some(383));
                assert_eq!(usage.output_tokens, Some(50));
            }
            other => panic!("expected done, saw {other:?}"),
        }
        assert_eq!(
            anthropic_message_chunks(
                &serde_json::json!({ "content": [], "stop_reason": "end_turn" })
            ),
            vec![Chunk::Done {
                finish_reason: "stop".into(),
                usage: None
            }]
        );
    }

    fn sse(kind: &str, value: serde_json::Value) -> SseEvent {
        SseEvent {
            event: Some(kind.to_string()),
            data: value.to_string(),
        }
    }

    #[test]
    fn the_live_fold_passes_each_tool_call_fragment_on_as_it_lands() {
        let mut fold = AnthropicFold::new("claude").with_live_tool_calls();
        let mut chunks = Vec::new();
        for event in [
            sse(
                "content_block_start",
                serde_json::json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "probe_echo", "input": {} } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "" } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"value\":" } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "\"hello\"}" } }),
            ),
            sse(
                "content_block_delta",
                serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig" } }),
            ),
            sse(
                "message_delta",
                serde_json::json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 12 } }),
            ),
            sse(
                "message_stop",
                serde_json::json!({ "type": "message_stop" }),
            ),
        ] {
            chunks.extend(fold.event(&event).expect("folds").chunks);
        }
        assert_eq!(
            chunks,
            vec![
                Chunk::ToolCallDelta {
                    index: 2,
                    id: Some("toolu_1".into()),
                    name: Some("probe_echo".into()),
                    arguments_delta: String::new(),
                },
                Chunk::ToolCallDelta {
                    index: 2,
                    id: None,
                    name: None,
                    arguments_delta: "{\"value\":".into(),
                },
                Chunk::ToolCallDelta {
                    index: 2,
                    id: None,
                    name: None,
                    arguments_delta: "\"hello\"}".into(),
                },
                Chunk::ToolCall(ToolCall {
                    id: "toolu_1".into(),
                    name: "probe_echo".into(),
                    arguments: "{\"value\":\"hello\"}".into(),
                }),
                Chunk::Done {
                    finish_reason: "tool_calls".into(),
                    usage: Some(TokenUsage {
                        output_tokens: Some(12),
                        ..TokenUsage::default()
                    }),
                },
            ],
            "an empty fragment carries nothing and a signature is not the loop's"
        );
    }

    #[test]
    fn the_publisher_routes_fold_stays_without_live_fragments() {
        let mut fold = AnthropicFold::new("claude");
        let folded = fold
            .event(&sse(
                "content_block_start",
                serde_json::json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "bash" } }),
            ))
            .expect("folds");
        assert!(folded.chunks.is_empty());
    }
}
