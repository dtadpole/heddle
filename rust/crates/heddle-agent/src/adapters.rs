//! The turn's ports over the real crates, where they have landed.
//!
//! [`LlmModel`] is the [`ModelPort`] over `heddle-llm`'s [`ModelService`]. It converts nothing but the error:
//! the request, the chunks and the usage are the model service's own types (see [`crate::upstream`]). The
//! service already runs the `model/request` and `model/stream` hooks, drops reasoning-only assistant turns at
//! the provider boundary and projects attachments, so the loop hands it the recorded messages as they are.
//!
//! The session, context and hook adapters land here when `heddle-session`, `heddle-context` and
//! `heddle-events` reach main; until then the binary passes its own implementations of those ports.

use std::sync::Arc;

use futures::StreamExt;
use futures::stream::BoxStream;
use tokio_util::sync::CancellationToken;

use heddle_llm::ModelService;

use crate::ports::{ModelError, ModelPort};
use crate::upstream::{Chunk, GenerateRequest};

/// The [`ModelPort`] over a [`ModelService`].
///
/// A Stop drops the provider stream (`take_until` on the call's token), which drops the request with it — the
/// Rust form of the TypeScript `AbortSignal` passed to `fetch`. A request to an endpoint the service does not
/// know fails as one error item (`NO_ENDPOINT`) before any connection is made.
pub struct LlmModel {
    service: Arc<ModelService>,
}

impl LlmModel {
    /// Wrap the deployment's model service.
    pub fn new(service: Arc<ModelService>) -> Self {
        Self { service }
    }

    /// The service this port asks.
    pub fn service(&self) -> &Arc<ModelService> {
        &self.service
    }
}

impl ModelPort for LlmModel {
    fn stream(
        &self,
        request: GenerateRequest,
        cancel: Option<CancellationToken>,
    ) -> BoxStream<'static, Result<Chunk, ModelError>> {
        match self.service.stream(request) {
            Err(error) => Box::pin(futures::stream::once(async move {
                Err(ModelError::from(error))
            })),
            Ok(stream) => {
                let stream = stream.map(|item| item.map_err(ModelError::from));
                match cancel {
                    Some(cancel) => Box::pin(stream.take_until(cancel.cancelled_owned())),
                    None => Box::pin(stream),
                }
            }
        }
    }

    fn default_endpoint(&self) -> Option<String> {
        self.service.default_endpoint(None)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::PathBuf;

    use heddle_llm::EndpointConfig;
    use serde_json::json;

    use super::*;
    use crate::upstream::{ContentPart, Message, Role, ToolCall};

    /// A scratch folder holding one scripted endpoint's step file.
    pub(crate) fn scripted_service(label: &str, steps: serde_json::Value) -> Arc<ModelService> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir: PathBuf = std::env::temp_dir().join(format!(
            "heddle-agent-scripted-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("script.json");
        std::fs::write(&script, json!({ "steps": steps }).to_string()).unwrap();
        let endpoint: EndpointConfig = serde_json::from_value(json!({
            "name": "scripted",
            "kind": "scripted",
            "baseUrl": script,
            "model": "scripted",
        }))
        .unwrap();
        Arc::new(ModelService::from_configuration(vec![endpoint], Some("scripted")).unwrap())
    }

    fn request(round: u32) -> GenerateRequest {
        GenerateRequest {
            endpoint: "scripted".into(),
            messages: vec![Message::new(Role::User, vec![ContentPart::text("go")])],
            round: Some(round),
            ..GenerateRequest::default()
        }
    }

    async fn collect(port: &LlmModel, request: GenerateRequest) -> Vec<Result<Chunk, ModelError>> {
        port.stream(request, None).collect().await
    }

    #[tokio::test]
    async fn a_scripted_round_streams_its_tool_call_and_finishes_for_tools() {
        let port = LlmModel::new(scripted_service(
            "call",
            json!([
                { "toolCall": { "name": "read_file", "arguments": { "path": "a.txt" } } },
                { "text": "done" }
            ]),
        ));
        let chunks: Vec<Chunk> = collect(&port, request(0))
            .await
            .into_iter()
            .map(Result::unwrap)
            .collect();
        assert!(
            chunks.contains(&Chunk::ToolCall(ToolCall {
                id: "call-read_file".into(),
                name: "read_file".into(),
                arguments: json!({ "path": "a.txt" }).to_string(),
            })),
            "{chunks:?}"
        );
        assert!(matches!(
            chunks.last(),
            Some(Chunk::Done { finish_reason, .. }) if finish_reason == "tool_calls"
        ));

        let second: Vec<Chunk> = collect(&port, request(1))
            .await
            .into_iter()
            .map(Result::unwrap)
            .collect();
        assert!(second.contains(&Chunk::TextDelta {
            text: "done".into()
        }));
    }

    #[tokio::test]
    async fn an_unknown_endpoint_fails_as_one_coded_error_item() {
        let port = LlmModel::new(scripted_service("unknown", json!([])));
        let mut asked = request(0);
        asked.endpoint = "nowhere".into();
        let items = collect(&port, asked).await;
        assert_eq!(items.len(), 1);
        let error = items.into_iter().next().unwrap().unwrap_err();
        assert_eq!(error.code.as_deref(), Some("NO_ENDPOINT"));
    }

    #[tokio::test]
    async fn a_scripted_failure_keeps_its_code_for_the_retry_rule() {
        let port = LlmModel::new(scripted_service(
            "overflow",
            json!([{ "error": { "code": "CONTEXT_WINDOW_EXCEEDED", "message": "too long" } }]),
        ));
        let error = collect(&port, request(0))
            .await
            .into_iter()
            .find_map(Result::err)
            .expect("the step fails the call");
        assert_eq!(error.code.as_deref(), Some("CONTEXT_WINDOW_EXCEEDED"));
        assert!(error.message.contains("too long"), "{}", error.message);
    }

    #[tokio::test]
    async fn a_stopped_call_yields_nothing() {
        let port = LlmModel::new(scripted_service("stop", json!([{ "text": "never seen" }])));
        let token = CancellationToken::new();
        token.cancel();
        let items: Vec<_> = port.stream(request(0), Some(token)).collect().await;
        assert!(items.is_empty(), "{items:?}");
    }

    #[test]
    fn the_default_endpoint_is_the_nominated_one() {
        let port = LlmModel::new(scripted_service("default", json!([])));
        assert_eq!(port.default_endpoint().as_deref(), Some("scripted"));
    }
}
