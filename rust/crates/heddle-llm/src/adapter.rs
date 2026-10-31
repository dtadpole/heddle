//! The [`Adapter`] trait, the choice of adapter for an endpoint, and the driver that folds an event stream.
//!
//! Ported from `Adapter`, `adapterFor`, `reasoningValue`, `post` and `hop` in `src/llm/{types,adapters}.ts`.
//!
//! Each HTTP adapter is split in two halves that are judged separately:
//!
//! - a **pure request builder** (`chat_request`, `responses_request`, `anthropic_call`) that returns a
//!   [`PreparedCall`] — URL, JSON body, headers, streaming flag — so the translation is asserted without a socket;
//! - a **pure fold** implementing [`StreamFold`] that turns parsed events into [`Chunk`]s, so the provider's event
//!   vocabulary is asserted by feeding it literals.
//!
//! [`fold_sse`] drives a fold over a live body. Cancellation is by **dropping** the [`ChunkStream`]: the request is
//! abandoned with it. A caller that wants an `ABORTED` error constructs one; nothing here takes a signal.

use std::pin::Pin;
use std::sync::Arc;

use std::collections::VecDeque;

use futures::{Stream, StreamExt};

use crate::error::ModelError;
use crate::http::ByteStream;
use crate::sse::{SseEvent, read_sse};
use crate::types::{Chunk, GenerateRequest};
use heddle_config::{EndpointConfig, ReasoningValue};

/// One call's answer, chunk by chunk. An error ends it.
pub type ChunkStream = Pin<Box<dyn Stream<Item = Result<Chunk, ModelError>> + Send + 'static>>;

/// A provider backend: one wire shape, one endpoint.
pub trait Adapter: Send + Sync {
    /// The endpoint this adapter was built for.
    fn endpoint(&self) -> &EndpointConfig;

    /// One call, streamed. A failure building the request is the stream's first (and only) item.
    fn stream(&self, request: GenerateRequest) -> ChunkStream;
}

/// The adapter for an endpoint's declared kind (`adapterFor`). `heddle-config` keeps a kind it has no variant for as
/// [`crate::EndpointKind::Other`]; `anthropic-messages` is spoken here ([`crate::messages`]) and any other such kind is
/// refused with `UNKNOWN_KIND`.
pub fn adapter_for(endpoint: EndpointConfig) -> Result<Arc<dyn Adapter>, ModelError> {
    let adapter: Arc<dyn Adapter> = match endpoint.kind {
        heddle_config::EndpointKind::OpenaiChat => {
            Arc::new(crate::chat::ChatAdapter::new(endpoint))
        }
        heddle_config::EndpointKind::OpenaiResponses => {
            Arc::new(crate::responses::ResponsesAdapter::new(endpoint))
        }
        heddle_config::EndpointKind::AnthropicVertex => {
            Arc::new(crate::anthropic::AnthropicVertexAdapter::new(endpoint))
        }
        heddle_config::EndpointKind::Scripted => {
            Arc::new(crate::scripted::ScriptedAdapter::new(endpoint))
        }
        heddle_config::EndpointKind::Other(ref kind)
            if kind == crate::messages::ANTHROPIC_MESSAGES =>
        {
            Arc::new(crate::messages::AnthropicMessagesAdapter::new(endpoint))
        }
        heddle_config::EndpointKind::Other(ref kind) => {
            return Err(ModelError::new(
                format!("unknown endpoint kind '{kind}'"),
                endpoint.name.clone(),
                crate::error::code::UNKNOWN_KIND,
            ));
        }
    };
    Ok(adapter)
}

/// A request translated for one wire shape, before it is sent.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCall {
    pub url: String,
    pub body: serde_json::Value,
    /// Headers to send beyond the client's defaults (configured headers, Title-Cased).
    pub headers: Vec<(String, String)>,
    /// Whether the body asks the provider to stream.
    pub stream: bool,
}

/// The wire value of the reasoning level a request names (`reasoningValue`).
///
/// `Ok(None)` when no level is requested or the level's value is `null` (both send nothing); an id the model does
/// not declare is a loud `UNSUPPORTED_REASONING_EFFORT` naming the declared ids, never a silent drop. The level is
/// looked up on the model that will answer: `request.model`, else the endpoint's.
pub fn reasoning_value(
    endpoint: &EndpointConfig,
    request: &GenerateRequest,
) -> Result<Option<ReasoningValue>, ModelError> {
    let Some(id) = request
        .reasoning_effort
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let model = request
        .model
        .as_deref()
        .or(endpoint.model.as_deref())
        .filter(|model| !model.is_empty());
    match endpoint.reasoning_level_for(model, id) {
        Some(level) => Ok(level.value),
        None => {
            let declared = endpoint
                .reasoning_levels_for(model)
                .map(|levels| {
                    levels
                        .levels
                        .iter()
                        .map(|level| level.id.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| "(none)".to_string());
            Err(ModelError::new(
                format!(
                    "'{}' does not offer reasoning effort '{id}' for model '{}'; declared: {declared}",
                    endpoint.name,
                    model.unwrap_or("(none)")
                ),
                endpoint.name.clone(),
                crate::error::code::UNSUPPORTED_REASONING_EFFORT,
            ))
        }
    }
}

/// Whether an endpoint's models reason at all: the `reasoning` capability, an endpoint-level block, or any offered
/// model's own block. It decides whether a Responses request asks for a reasoning summary.
pub fn reasoning_configured(endpoint: &EndpointConfig) -> bool {
    endpoint
        .capabilities
        .as_ref()
        .is_some_and(|capabilities| capabilities.iter().any(|capability| capability == "reasoning"))
        || endpoint.reasoning.is_some()
        || endpoint.models.as_ref().is_some_and(|models| {
            models.iter().any(|entry| {
                matches!(entry, heddle_config::ModelEntry::Option(model) if model.reasoning.is_some())
            })
        })
}

/// A failure known before any body exists, as the stream's first and only item.
pub(crate) fn error_stream(error: ModelError) -> ChunkStream {
    Box::pin(futures::stream::once(async move {
        Err::<Chunk, ModelError>(error)
    }))
}

/// What one parsed event did to a fold.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Folded {
    /// Chunks to hand on, in order.
    pub chunks: Vec<Chunk>,
    /// The provider's terminal event arrived; the driver stops reading.
    pub finished: bool,
}

/// A provider's event vocabulary folded into chunks, one event at a time.
pub trait StreamFold: Send {
    /// One event in. A provider-reported failure is an error (`REMOTE`); an unparseable `data:` is skipped.
    fn event(&mut self, event: &SseEvent) -> Result<Folded, ModelError>;

    /// The body ended without a terminal event: whatever the fold still owes (assembled tool calls, a `done`).
    fn end(&mut self) -> Vec<Chunk>;
}

/// Drive a fold over a streamed body: parse events, fold each, stop at the terminal one or at the body's end.
///
/// `end` is asked for its tail only when the body ended without a terminal event, so a fold that already answered
/// `finished` is not asked to finish twice.
pub fn fold_sse(body: ByteStream, fold: Box<dyn StreamFold>) -> ChunkStream {
    let state = (read_sse(body), fold, VecDeque::new(), false);
    Box::pin(futures::stream::unfold(
        state,
        |(mut events, mut fold, mut queue, mut done)| async move {
            loop {
                if let Some(item) = queue.pop_front() {
                    return Some((item, (events, fold, queue, done)));
                }
                if done {
                    return None;
                }
                match events.next().await {
                    Some(Ok(event)) => match fold.event(&event) {
                        Ok(folded) => {
                            queue.extend(folded.chunks.into_iter().map(Ok));
                            if folded.finished {
                                done = true;
                            }
                        }
                        Err(error) => {
                            done = true;
                            queue.push_back(Err(error));
                        }
                    },
                    Some(Err(error)) => {
                        done = true;
                        queue.push_back(Err(error));
                    }
                    None => {
                        done = true;
                        queue.extend(fold.end().into_iter().map(Ok));
                    }
                }
            }
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use heddle_config::{EndpointKind, ModelEntry, ModelOption, ReasoningLevel, ReasoningLevels};

    fn endpoint() -> EndpointConfig {
        EndpointConfig {
            name: "responses".into(),
            kind: EndpointKind::OpenaiResponses,
            base_url: "http://127.0.0.1:1".into(),
            model: None,
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

    fn levels() -> ReasoningLevels {
        ReasoningLevels {
            default: Some("default".into()),
            levels: vec![ReasoningLevel {
                id: "high".into(),
                name: "High".into(),
                value: Some(ReasoningValue::Text("high".into())),
            }],
        }
    }

    #[test]
    fn an_endpoint_reasons_when_it_declares_the_capability_a_block_or_a_models_own_block() {
        assert!(
            !reasoning_configured(&endpoint()),
            "nothing declared, nothing to ask for"
        );

        let mut capability = endpoint();
        capability.capabilities = Some(vec!["tools".into(), "reasoning".into()]);
        assert!(reasoning_configured(&capability));

        let mut block = endpoint();
        block.reasoning = Some(levels());
        assert!(reasoning_configured(&block));

        let mut own = endpoint();
        own.models = Some(vec![
            ModelEntry::Id("plain".into()),
            ModelEntry::Option(ModelOption {
                id: "thinking".into(),
                reasoning: Some(levels()),
                ..ModelOption::default()
            }),
        ]);
        assert!(
            reasoning_configured(&own),
            "one model's own block is enough"
        );
    }

    #[test]
    fn a_capability_list_without_reasoning_or_bare_model_ids_does_not_reason() {
        let mut tools_only = endpoint();
        tools_only.capabilities = Some(vec!["tools".into(), "offline".into()]);
        tools_only.models = Some(vec![ModelEntry::Id("plain".into())]);
        assert!(!reasoning_configured(&tools_only));
    }

    #[test]
    fn the_adapter_is_chosen_by_the_endpoints_declared_kind() {
        let scripted = adapter_for(EndpointConfig {
            name: "offline".into(),
            kind: EndpointKind::Scripted,
            base_url: "/tmp/script.json".into(),
            ..endpoint()
        })
        .expect("scripted is a known kind");
        assert_eq!(scripted.endpoint().name, "offline");

        for kind in [
            EndpointKind::OpenaiChat,
            EndpointKind::OpenaiResponses,
            EndpointKind::AnthropicVertex,
            EndpointKind::parse("anthropic-messages"),
        ] {
            let adapter = adapter_for(EndpointConfig {
                kind: kind.clone(),
                ..endpoint()
            })
            .unwrap_or_else(|error| panic!("{kind:?} is a known kind: {error}"));
            assert_eq!(adapter.endpoint().name, "responses");
        }
    }

    #[test]
    fn the_driver_folds_a_streamed_body_across_read_boundaries() {
        use bytes::Bytes;
        let body: ByteStream = Box::pin(futures::stream::iter(vec![
            Ok(Bytes::from_static(
                b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: ",
            )),
            Ok(Bytes::from_static(
                b"{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            )),
        ]));
        let chunks: Vec<Option<Chunk>> = futures::executor::block_on(
            fold_sse(body, Box::new(crate::chat::ChatFold::new())).collect::<Vec<_>>(),
        )
        .into_iter()
        .map(Result::ok)
        .collect();
        assert_eq!(
            chunks,
            vec![
                Some(Chunk::TextDelta { text: "hi".into() }),
                Some(Chunk::Done {
                    finish_reason: "stop".into(),
                    usage: None
                }),
            ]
        );
    }

    #[test]
    fn a_body_that_ends_without_a_terminal_event_gets_the_folds_tail() {
        use bytes::Bytes;
        let body: ByteStream = Box::pin(futures::stream::iter(vec![Ok(Bytes::from_static(
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"cut\"}\n\n",
        ))]));
        let chunks: Vec<_> = futures::executor::block_on(
            fold_sse(body, Box::new(crate::responses::ResponsesFold::new())).collect(),
        );
        assert_eq!(
            chunks.last().and_then(|item| item.as_ref().ok()),
            Some(&Chunk::Done {
                finish_reason: "stream_ended".into(),
                usage: None
            })
        );
    }

    #[test]
    fn a_kind_no_adapter_speaks_is_refused_by_name() {
        let error = match adapter_for(EndpointConfig {
            kind: EndpointKind::Other("mystery".into()),
            ..endpoint()
        }) {
            Ok(_) => panic!("an unknown kind has no adapter"),
            Err(error) => error,
        };
        assert_eq!(error.code, crate::error::code::UNKNOWN_KIND);
        assert_eq!(error.endpoint, "responses");
        assert!(error.to_string().contains("mystery"), "{error}");
    }

    fn level_set(ids: &[(&str, Option<ReasoningValue>)]) -> ReasoningLevels {
        ReasoningLevels {
            default: None,
            levels: ids
                .iter()
                .map(|(id, value)| ReasoningLevel {
                    id: (*id).to_string(),
                    name: (*id).to_string(),
                    value: value.clone(),
                })
                .collect(),
        }
    }

    fn with_levels(endpoint: EndpointConfig, levels: ReasoningLevels) -> EndpointConfig {
        EndpointConfig {
            reasoning: Some(levels),
            ..endpoint
        }
    }

    #[test]
    fn the_wire_value_of_a_declared_level_is_returned_and_a_null_level_sends_nothing() {
        let endpoint = with_levels(
            endpoint(),
            level_set(&[
                ("default", None),
                ("high", Some(ReasoningValue::Text("high".into()))),
                (
                    "budget",
                    Some(ReasoningValue::Number(serde_json::Number::from(8192))),
                ),
            ]),
        );
        let ask = |effort: Option<&str>| GenerateRequest {
            endpoint: "responses".into(),
            reasoning_effort: effort.map(ToString::to_string),
            ..GenerateRequest::default()
        };
        assert_eq!(
            reasoning_value(&endpoint, &ask(Some("high"))).expect("declared"),
            Some(ReasoningValue::Text("high".into()))
        );
        assert_eq!(
            reasoning_value(&endpoint, &ask(Some("budget"))).expect("declared"),
            Some(ReasoningValue::Number(serde_json::Number::from(8192)))
        );
        assert_eq!(
            reasoning_value(&endpoint, &ask(Some("default"))).expect("declared"),
            None,
            "a level whose value is null is real but sends nothing"
        );
        assert_eq!(reasoning_value(&endpoint, &ask(None)).expect("none"), None);
        assert_eq!(
            reasoning_value(&endpoint, &ask(Some(""))).expect("none"),
            None
        );
    }

    #[test]
    fn an_undeclared_level_is_refused_loudly_naming_the_declared_ids() {
        let mut endpoint = with_levels(
            endpoint(),
            level_set(&[
                ("low", Some(ReasoningValue::Text("low".into()))),
                ("high", Some(ReasoningValue::Text("high".into()))),
            ]),
        );
        endpoint.model = Some("m".into());
        let error = reasoning_value(
            &endpoint,
            &GenerateRequest {
                endpoint: "responses".into(),
                reasoning_effort: Some("extreme".into()),
                ..GenerateRequest::default()
            },
        )
        .expect_err("not declared");
        assert_eq!(error.code, crate::error::code::UNSUPPORTED_REASONING_EFFORT);
        assert!(error.to_string().contains("'extreme'"), "{error}");
        assert!(error.to_string().contains("low, high"), "{error}");
        assert!(
            error.to_string().contains("'m'"),
            "it names the model too: {error}"
        );
    }

    #[test]
    fn the_level_is_looked_up_on_the_model_that_will_answer() {
        let mut endpoint = with_levels(
            endpoint(),
            level_set(&[("shared", Some(ReasoningValue::Text("endpoint".into())))]),
        );
        endpoint.models = Some(vec![ModelEntry::Option(ModelOption {
            id: "thinking".into(),
            reasoning: Some(level_set(&[(
                "shared",
                Some(ReasoningValue::Text("model".into())),
            )])),
            ..ModelOption::default()
        })]);
        // The model's own block replaces the endpoint's, so the wire value is the model's.
        assert_eq!(
            reasoning_value(
                &endpoint,
                &GenerateRequest {
                    endpoint: "responses".into(),
                    model: Some("thinking".into()),
                    reasoning_effort: Some("shared".into()),
                    ..GenerateRequest::default()
                }
            )
            .expect("declared"),
            Some(ReasoningValue::Text("model".into()))
        );
        // A level only the endpoint declares is not offered by a model that declares its own block.
        let mut endpoint = with_levels(
            endpoint,
            level_set(&[("endpoint-only", Some(ReasoningValue::Text("x".into())))]),
        );
        endpoint.models = Some(vec![ModelEntry::Option(ModelOption {
            id: "thinking".into(),
            reasoning: Some(level_set(&[(
                "low",
                Some(ReasoningValue::Text("low".into())),
            )])),
            ..ModelOption::default()
        })]);
        assert!(
            reasoning_value(
                &endpoint,
                &GenerateRequest {
                    endpoint: "responses".into(),
                    model: Some("thinking".into()),
                    reasoning_effort: Some("endpoint-only".into()),
                    ..GenerateRequest::default()
                }
            )
            .is_err()
        );
    }
}
