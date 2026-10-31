//! The model service: a registry of endpoints, one streaming call, and the `model/*` interception seam.
//!
//! Ported from `ModelService`, `withDiscoveredModalities` and `lastAssistantText` in `src/llm/service.ts`, and the
//! service half of `src/plugins/model.ts` ([`ModelService::from_configuration`], [`ModelService::summary_line`]).
//! Reading the configuration is not here: the binary's boot resolves the endpoint list (`heddle-config`) and hands
//! it in.
//!
//! # One call, in order
//!
//! [`ModelService::stream`] looks the endpoint up (`NO_ENDPOINT`), runs the **`model/request`** hooks over the
//! request, looks the possibly-rewritten endpoint up again, drops reasoning-only assistant turns
//! ([`crate::types::request_messages`]), and returns a stream that — when first polled — discovers input
//! modalities from the provider's model list only if the request carries an image and the endpoint declares none,
//! projects attachments ([`crate::attachments::project_attachments`]), and runs the **`model/stream`** hooks
//! around the adapter's stream.
//!
//! # The hook seam
//!
//! [`ModelHooks`] stands in for the event bus's two waterfalls until `heddle-events` lands, and stays the seam
//! afterwards: the boot registers one implementation that dispatches to the bus. The semantics are Cordis's
//! waterfall: hooks run **outermost first, in registration order**; each receives the original value and a `next`
//! that runs the rest of the chain (the innermost `next` returns the request unchanged, or calls the adapter); a
//! hook that does not call `next` vetoes the rest.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures::StreamExt;
use serde::Serialize;

use crate::adapter::{Adapter, ChunkStream};
use heddle_config::EndpointConfig;

use crate::attachments::{IMAGE_REQUEST_LIMITS, project_attachments};
use crate::error::ModelError;
use crate::model_info::{InputModality, ModelInfoOptions, ModelListCache};
use crate::types::{
    Chunk, ContentPart, GenerateRequest, Message, ToolCall, request_messages, text_of, user_message,
};

/// The waterfall over a request before an adapter is chosen.
pub const HOOK_MODEL_REQUEST: &str = "model/request";
/// The waterfall around every adapter stream.
pub const HOOK_MODEL_STREAM: &str = "model/stream";

/// The `model/request` and `model/stream` interception points. Both default to passing through.
pub trait ModelHooks: Send + Sync {
    /// `model/request`: return a replacement request (how a model-selection policy works), or `next()`'s result.
    /// `service` is the service dispatching, for `names()` / `endpoint()` lookups.
    ///
    /// An `Err` fails the call before any stream exists, as a listener that throws does in the TypeScript build's
    /// waterfall; the hook chooses the error's code and sentence, and [`ModelService::stream`] returns it as is.
    fn request(
        &self,
        service: &ModelService,
        request: &GenerateRequest,
        next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
    ) -> Result<GenerateRequest, ModelError> {
        let _ = (service, request);
        next()
    }

    /// `model/stream`: return `next()` (possibly wrapped, to record or retry) or a stream of your own.
    fn stream(
        &self,
        request: &GenerateRequest,
        next: Box<dyn FnOnce() -> ChunkStream + Send>,
    ) -> ChunkStream {
        let _ = request;
        next()
    }
}

/// A registration handle: pass it to [`ModelService::remove_hooks`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HooksId(u64);

/// One call, collected (`generate`). JSON: `{"text","reasoning","toolCalls","finishReason"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    pub text: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    /// `unknown` when the stream carried no `done`.
    pub finish_reason: String,
}

/// What a probe may be told.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeOptions {
    /// Default `Reply with the single word: ready`.
    pub prompt: Option<String>,
    /// Default 16.
    pub max_output_tokens: Option<u64>,
    pub model: Option<String>,
}

/// A probe's answer. JSON: `{"endpoint","model"?,"text","finishReason","milliseconds"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub text: String,
    pub finish_reason: String,
    pub milliseconds: u64,
}

/// Where a changed configuration comes from: asked before every read and every call, it answers the new endpoints
/// and default when the configuration changed since it last answered, and `None` when it did not.
pub type RefreshSource =
    Arc<dyn Fn() -> Option<(Vec<EndpointConfig>, Option<String>)> + Send + Sync>;

/// The model service. Shared as `Arc<ModelService>`; every method takes `&self`.
pub struct ModelService {
    adapters: std::sync::RwLock<Vec<Arc<dyn Adapter>>>,
    nominated: std::sync::RwLock<Option<String>>,
    refresh: std::sync::RwLock<Option<RefreshSource>>,
    hooks: std::sync::RwLock<Vec<(HooksId, Arc<dyn ModelHooks>)>>,
    next_hooks_id: AtomicU64,
    model_lists: Arc<ModelListCache>,
}

impl ModelService {
    /// A service holding these endpoints, in this order. `UNKNOWN_KIND` for an endpoint no adapter speaks.
    pub fn new(endpoints: Vec<EndpointConfig>) -> Result<Self, ModelError> {
        let service = Self {
            adapters: std::sync::RwLock::new(Vec::new()),
            nominated: std::sync::RwLock::new(None),
            refresh: std::sync::RwLock::new(None),
            hooks: std::sync::RwLock::new(Vec::new()),
            next_hooks_id: AtomicU64::new(0),
            model_lists: Arc::new(ModelListCache::new()),
        };
        for endpoint in endpoints {
            service.register(endpoint)?;
        }
        Ok(service)
    }

    /// The model plugin's composition (`plugins/model.ts`): the resolved endpoint list plus the nominated default,
    /// recorded only when it names an endpoint that exists.
    pub fn from_configuration(
        endpoints: Vec<EndpointConfig>,
        nominated: Option<&str>,
    ) -> Result<Self, ModelError> {
        let service = Self::new(endpoints)?;
        if let Some(nominated) = nominated {
            service.nominate_default(nominated);
        }
        Ok(service)
    }

    /// The plugin's log line: `model: N endpoint(s) — name(kind[,credential]), …`. No credential value appears.
    pub fn summary_line(&self) -> String {
        let adapters = self.adapters();
        let described = adapters
            .iter()
            .map(|adapter| {
                let endpoint = adapter.endpoint();
                let credential = if endpoint.api_key.is_some() {
                    ",credential"
                } else {
                    ""
                };
                format!("{}({}{credential})", endpoint.name, endpoint.kind)
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("model: {} endpoint(s) — {described}", adapters.len())
    }

    /// Ask `source` before every read and every call, and swap in what it answers (`setRefresh`): a configuration
    /// change applies to the next request without a restart, as DSH's provider settings do.
    pub fn set_refresh(&self, source: RefreshSource) {
        *self
            .refresh
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(source);
    }

    /// Replace every endpoint and the nominated default at once (`reconfigure`). Every adapter is built before
    /// anything is replaced, so an endpoint no adapter speaks leaves the service as it was; a stream already started
    /// holds its own adapter and finishes on the configuration it began with.
    pub fn reconfigure(
        &self,
        endpoints: Vec<EndpointConfig>,
        nominated: Option<&str>,
    ) -> Result<(), ModelError> {
        let next = endpoints
            .into_iter()
            .map(crate::adapter::adapter_for)
            .collect::<Result<Vec<_>, _>>()?;
        let present = |name: &str| next.iter().any(|adapter| adapter.endpoint().name == name);
        let nominated = nominated.filter(|name| present(name)).map(str::to_string);
        *self
            .adapters
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = next;
        *self
            .nominated
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = nominated;
        Ok(())
    }

    /// Ask the refresh source, if any; a configuration it answers that cannot be built keeps the previous one.
    fn refresh(&self) {
        let source = self
            .refresh
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some((endpoints, nominated)) = source.and_then(|source| source())
            && let Err(error) = self.reconfigure(endpoints, nominated.as_deref())
        {
            tracing::warn!(
                "model: the changed configuration cannot be used ({error}); the previous endpoints stay"
            );
        }
    }

    /// Add an endpoint, replacing one of the same name in place; its discovered modalities are dropped with it.
    pub fn register(&self, endpoint: EndpointConfig) -> Result<(), ModelError> {
        let adapter = crate::adapter::adapter_for(endpoint)?;
        let name = adapter.endpoint().name.clone();
        let mut adapters = self
            .adapters
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match adapters
            .iter()
            .position(|held| held.endpoint().name == name)
        {
            Some(at) => adapters[at] = adapter,
            None => adapters.push(adapter),
        }
        Ok(())
    }

    /// Every endpoint, in declaration order (`list`).
    pub fn list(&self) -> Vec<EndpointConfig> {
        self.adapters()
            .iter()
            .map(|adapter| adapter.endpoint().clone())
            .collect()
    }

    /// The endpoints' names, which is what `--endpoint` accepts (`names`).
    pub fn names(&self) -> Vec<String> {
        self.adapters()
            .iter()
            .map(|adapter| adapter.endpoint().name.clone())
            .collect()
    }

    /// One endpoint's configuration (`endpoint`).
    pub fn endpoint(&self, name: &str) -> Option<EndpointConfig> {
        self.adapters()
            .iter()
            .find(|adapter| adapter.endpoint().name == name)
            .map(|adapter| adapter.endpoint().clone())
    }

    /// The endpoint a caller means when it names none (`defaultEndpoint`): `nominated` if given and present, else
    /// the configuration's nominated default if present, else the first endpoint.
    pub fn default_endpoint(&self, nominated: Option<&str>) -> Option<String> {
        let names: Vec<String> = self.names();
        let candidate = nominated
            .map(ToString::to_string)
            .or_else(|| self.nominated());
        match candidate {
            Some(candidate) if names.contains(&candidate) => Some(candidate),
            _ => names.first().cloned(),
        }
    }

    /// Record the configuration's default, if it names an endpoint that exists (`nominateDefault`).
    pub fn nominate_default(&self, name: &str) {
        if self.names().iter().any(|held| held == name) {
            *self
                .nominated
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(name.to_string());
        }
    }

    /// The recorded default, if any. The composer's endpoint listing reports it.
    pub fn nominated(&self) -> Option<String> {
        self.refresh();
        self.nominated
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Register `model/request` / `model/stream` hooks, after (inside) every hook already registered.
    pub fn add_hooks(&self, hooks: Arc<dyn ModelHooks>) -> HooksId {
        let id = HooksId(self.next_hooks_id.fetch_add(1, Ordering::Relaxed) + 1);
        self.hooks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((id, hooks));
        id
    }

    /// Remove hooks by handle; `false` when they were not registered.
    pub fn remove_hooks(&self, id: HooksId) -> bool {
        let mut hooks = self
            .hooks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = hooks.len();
        hooks.retain(|(held, _)| *held != id);
        hooks.len() != before
    }

    /// The model-list cache this service reads through, for a caller that prices a context window.
    pub fn model_lists(&self) -> &Arc<ModelListCache> {
        &self.model_lists
    }

    /// The request a call sends after the `model/request` waterfall, without sending it (issue #14).
    ///
    /// The turn loop records each model request before the call, and the record must name what the call sends:
    /// a selection policy on this waterfall (the server's running-turn rule) may move a step to another endpoint,
    /// model or level. The loop resolves once, records the answer, and hands it to [`ModelService::stream_resolved`],
    /// so the waterfall runs **once per call**: a listener may rewrite or have effects, and running it again could
    /// send something other than what was recorded. `NO_ENDPOINT` when the request names no configured endpoint.
    pub fn resolve(&self, request: &GenerateRequest) -> Result<GenerateRequest, ModelError> {
        self.adapter_for(&request.endpoint)?;
        self.request_through_hooks(request)
    }

    /// Call one endpoint and stream the answer (`stream`): [`ModelService::resolve`], then
    /// [`ModelService::stream_resolved`]. `NO_ENDPOINT` is returned before any stream exists.
    pub fn stream(&self, request: GenerateRequest) -> Result<ChunkStream, ModelError> {
        let effective = self.resolve(&request)?;
        self.stream_resolved(effective)
    }

    /// Stream a request [`ModelService::resolve`] already answered; the `model/request` waterfall is not run again.
    pub fn stream_resolved(&self, effective: GenerateRequest) -> Result<ChunkStream, ModelError> {
        let resolved = self.adapter_for(&effective.endpoint)?;
        // The provider boundary drops assistant turns that carry only reasoning. Applied after the request hook,
        // so a policy listener sees the request as it was recorded.
        let base = GenerateRequest {
            messages: request_messages(&effective.messages),
            ..effective
        };

        let hooks = self.hook_list();
        let model_lists = self.model_lists.clone();
        let lazy = futures::stream::once(async move {
            // Capability discovery sits between the request hook and the attachment projection: an image may be
            // sent only to a route that accepts one, and both steps are inside the stream, so a turn without an
            // image never reads the model list for one.
            let carries_image = base.messages.iter().any(|message| {
                message
                    .content
                    .iter()
                    .any(|part| matches!(part, ContentPart::Image(_)))
            });
            let endpoint = if carries_image {
                let configured = resolved.endpoint();
                let discovered = if configured.input_modalities.is_some()
                    || matches!(configured.kind, heddle_config::EndpointKind::Scripted)
                {
                    None
                } else {
                    model_lists
                        .input_modalities(
                            configured,
                            &ModelInfoOptions {
                                ask_about: base.model.clone(),
                                timeout_ms: None,
                            },
                        )
                        .await
                };
                with_discovered_modalities(configured, discovered.as_deref())
            } else {
                resolved.endpoint().clone()
            };
            let sendable = GenerateRequest {
                messages: project_attachments(&base.messages, &endpoint, IMAGE_REQUEST_LIMITS),
                ..base
            };
            stream_through_hooks(&hooks, &sendable, resolved, sendable.clone())
        })
        .flatten();
        Ok(Box::pin(lazy))
    }

    /// One call, collected — the same stream, folded (`generate`).
    pub async fn generate(&self, request: GenerateRequest) -> Result<Generated, ModelError> {
        let mut stream = self.stream(request)?;
        let mut generated = Generated {
            text: String::new(),
            reasoning: String::new(),
            tool_calls: Vec::new(),
            finish_reason: "unknown".to_string(),
        };
        while let Some(item) = stream.next().await {
            match item? {
                Chunk::TextDelta { text } => generated.text.push_str(&text),
                Chunk::ReasoningDelta { text } => generated.reasoning.push_str(&text),
                Chunk::ToolCall(call) => generated.tool_calls.push(call),
                // A live fragment of a call that arrives whole above; it is not the finish.
                Chunk::ToolCallDelta { .. } => {}
                Chunk::Done { finish_reason, .. } => generated.finish_reason = finish_reason,
            }
        }
        Ok(generated)
    }

    /// The cheapest call that proves an endpoint answers: one user turn, a 16-token cap, no tools (`probe`).
    pub async fn probe(
        &self,
        endpoint: &str,
        options: ProbeOptions,
    ) -> Result<ProbeResult, ModelError> {
        let started = std::time::Instant::now();
        let configured = self
            .endpoint(endpoint)
            .ok_or_else(|| no_endpoint_error(endpoint, &self.names()))?;
        let request = GenerateRequest {
            endpoint: endpoint.to_string(),
            messages: vec![user_message(
                options
                    .prompt
                    .unwrap_or_else(|| "Reply with the single word: ready".to_string()),
            )],
            max_output_tokens: Some(options.max_output_tokens.unwrap_or(16)),
            model: options.model,
            ..GenerateRequest::default()
        };
        let model = request
            .model
            .clone()
            .or_else(|| configured.model.clone())
            .filter(|model| !model.is_empty());
        let result = self.generate(request).await?;
        Ok(ProbeResult {
            endpoint: endpoint.to_string(),
            model,
            text: result.text,
            finish_reason: result.finish_reason,
            milliseconds: started.elapsed().as_millis() as u64,
        })
    }

    /// The adapter a request addresses, or `NO_ENDPOINT` naming what is configured.
    fn adapter_for(&self, name: &str) -> Result<Arc<dyn Adapter>, ModelError> {
        self.adapters()
            .iter()
            .find(|adapter| adapter.endpoint().name == name)
            .cloned()
            .ok_or_else(|| no_endpoint_error(name, &self.names()))
    }

    fn adapters(&self) -> Vec<Arc<dyn Adapter>> {
        self.refresh();
        self.adapters
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn hook_list(&self) -> Vec<(HooksId, Arc<dyn ModelHooks>)> {
        self.hooks
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The `model/request` waterfall: outermost first, in registration order. The first failure ends it.
    fn request_through_hooks(
        &self,
        request: &GenerateRequest,
    ) -> Result<GenerateRequest, ModelError> {
        let hooks = self.hook_list();
        fn step(
            hooks: &[(HooksId, Arc<dyn ModelHooks>)],
            index: usize,
            service: &ModelService,
            request: &GenerateRequest,
        ) -> Result<GenerateRequest, ModelError> {
            let Some((_, hook)) = hooks.get(index) else {
                return Ok(request.clone());
            };
            let mut next = || step(hooks, index + 1, service, request);
            hook.request(service, request, &mut next)
        }
        step(&hooks, 0, self, request)
    }
}

/// The no-endpoint failure, naming what is configured so a typo is diagnosable.
fn no_endpoint_error(name: &str, names: &[String]) -> ModelError {
    let configured = if names.is_empty() {
        "(none)".to_string()
    } else {
        names.join(", ")
    };
    ModelError::new(
        format!("no endpoint named '{name}'; configured: {configured}"),
        name,
        crate::error::code::NO_ENDPOINT,
    )
}

/// The `model/stream` waterfall: wrap `adapter` in every hook, outermost first.
fn stream_through_hooks(
    hooks: &[(HooksId, Arc<dyn ModelHooks>)],
    request: &GenerateRequest,
    adapter: Arc<dyn Adapter>,
    sendable: GenerateRequest,
) -> ChunkStream {
    let mut chain: Box<dyn FnOnce() -> ChunkStream + Send> =
        Box::new(move || adapter.stream(sendable));
    for (_, hook) in hooks.iter().rev() {
        let hook = hook.clone();
        let request = request.clone();
        let inner = chain;
        chain = Box::new(move || hook.stream(&request, inner));
    }
    chain()
}

/// The endpoint with the modalities a provider published, when it declared none (`withDiscoveredModalities`).
///
/// The configuration wins: a declared list is the operator's statement, and discovery only fills a blank. A
/// provider that said nothing leaves the endpoint untouched, which reads as text only downstream.
pub fn with_discovered_modalities(
    endpoint: &EndpointConfig,
    discovered: Option<&[InputModality]>,
) -> EndpointConfig {
    if endpoint.input_modalities.is_some() {
        return endpoint.clone();
    }
    let Some(discovered) = discovered else {
        return endpoint.clone();
    };
    EndpointConfig {
        input_modalities: Some(
            discovered
                .iter()
                .map(|modality| modality.as_str().to_string())
                .collect(),
        ),
        ..endpoint.clone()
    }
}

/// The last assistant message's text, for a transcript reader (`lastAssistantText`).
pub fn last_assistant_text(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .find(|message| message.role == crate::types::Role::Assistant)
        .map(|message| text_of(&message.content))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::adapter::ChunkStream;
    use heddle_config::EndpointKind;

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "heddle-service-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).expect("creates the temp dir");
            Self { dir }
        }

        fn script(&self, name: &str, body: serde_json::Value) -> PathBuf {
            let path = self.dir.join(format!("{name}.json"));
            std::fs::write(&path, body.to_string()).expect("writes the script");
            path
        }

        fn endpoint(&self, name: &str, body: serde_json::Value) -> EndpointConfig {
            self.endpoint_with(name, body, None)
        }

        fn endpoint_with(
            &self,
            name: &str,
            body: serde_json::Value,
            model: Option<&str>,
        ) -> EndpointConfig {
            let path = self.script(name, body);
            EndpointConfig {
                name: name.to_string(),
                kind: EndpointKind::Scripted,
                base_url: path.to_string_lossy().into_owned(),
                model: model.map(ToString::to_string),
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
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn ask(endpoint: &str) -> GenerateRequest {
        GenerateRequest {
            endpoint: endpoint.to_string(),
            messages: vec![user_message("hi")],
            ..GenerateRequest::default()
        }
    }

    #[test]
    fn a_service_holds_its_endpoints_in_order_and_replaces_one_of_the_same_name() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [] })),
            fixture.endpoint("b", json!({ "steps": [] })),
        ])
        .expect("registers");
        assert_eq!(service.names(), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(service.list().len(), 2);
        assert_eq!(
            service.endpoint("b").map(|endpoint| endpoint.name),
            Some("b".to_string())
        );
        assert_eq!(service.endpoint("missing"), None);

        let mut replaced = fixture.endpoint("a", json!({ "steps": [] }));
        replaced.model = Some("other".into());
        service.register(replaced).expect("replaces");
        assert_eq!(service.list().len(), 2, "a name is replaced in place");
        assert_eq!(
            service.endpoint("a").and_then(|e| e.model),
            Some("other".into())
        );
    }

    #[test]
    fn a_kind_no_adapter_speaks_is_refused_when_it_is_registered() {
        let fixture = Fixture::new();
        let mut endpoint = fixture.endpoint("a", json!({ "steps": [] }));
        endpoint.kind = EndpointKind::Other("mystery".into());
        let error = match ModelService::new(vec![endpoint]) {
            Ok(_) => panic!("a kind no adapter speaks is refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, crate::error::code::UNKNOWN_KIND);
    }

    #[test]
    fn the_default_is_the_named_one_the_nominated_one_or_the_first() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [] })),
            fixture.endpoint("b", json!({ "steps": [] })),
        ])
        .expect("registers");
        assert_eq!(service.default_endpoint(None), Some("a".to_string()));
        assert_eq!(service.default_endpoint(Some("b")), Some("b".to_string()));
        assert_eq!(
            service.default_endpoint(Some("missing")),
            Some("a".to_string()),
            "a name that is not there is not a selection"
        );
        service.nominate_default("b");
        assert_eq!(service.nominated(), Some("b".to_string()));
        assert_eq!(service.default_endpoint(None), Some("b".to_string()));
        service.nominate_default("missing");
        assert_eq!(
            service.nominated(),
            Some("b".to_string()),
            "an unknown name changes nothing"
        );
    }

    #[test]
    fn a_refresh_source_swaps_endpoints_and_default_on_the_next_read() {
        let fixture = Fixture::new();
        let service = ModelService::from_configuration(
            vec![fixture.endpoint("a", json!({ "steps": [] }))],
            Some("a"),
        )
        .expect("registers");
        let edited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let next = vec![
            fixture.endpoint("b", json!({ "steps": [] })),
            fixture.endpoint("c", json!({ "steps": [] })),
        ];
        let flag = Arc::clone(&edited);
        service.set_refresh(Arc::new(move || {
            flag.swap(false, Ordering::SeqCst)
                .then(|| (next.clone(), Some("c".to_string())))
        }));
        assert_eq!(
            service.names(),
            vec!["a".to_string()],
            "nothing changed yet"
        );
        edited.store(true, Ordering::SeqCst);
        assert_eq!(
            service.names(),
            vec!["b".to_string(), "c".to_string()],
            "the next read sees the edit"
        );
        assert_eq!(service.default_endpoint(None), Some("c".to_string()));
        assert_eq!(
            service.names(),
            vec!["b".to_string(), "c".to_string()],
            "and keeps it"
        );

        service
            .reconfigure(
                vec![fixture.endpoint("d", json!({ "steps": [] }))],
                Some("missing"),
            )
            .expect("reconfigures");
        assert_eq!(
            service.nominated(),
            None,
            "a default the new list lacks is no default"
        );
        assert_eq!(service.default_endpoint(None), Some("d".to_string()));
    }

    #[test]
    fn a_request_to_an_unregistered_endpoint_is_refused_before_a_stream_exists() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![fixture.endpoint("a", json!({ "steps": [] }))])
            .expect("registers");
        let error = match service.stream(ask("missing")) {
            Ok(_) => panic!("an unknown endpoint has no adapter"),
            Err(error) => error,
        };
        assert_eq!(error.code, crate::error::code::NO_ENDPOINT);
        assert!(error.to_string().contains("configured: a"), "{error}");
    }

    #[tokio::test]
    async fn a_scripted_call_streams_and_collects_into_one_answer() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![fixture.endpoint(
            "a",
            json!({ "steps": [{
                "reasoning": "hm",
                "text": "answer",
                "toolCall": { "name": "bash", "arguments": { "command": "ls" } }
            }] }),
        )])
        .expect("registers");
        let generated = service.generate(ask("a")).await.expect("answers");
        assert_eq!(generated.text, "answer");
        assert_eq!(generated.reasoning, "hm");
        assert_eq!(
            generated.tool_calls,
            vec![ToolCall {
                id: "call-bash".into(),
                name: "bash".into(),
                arguments: r#"{"command":"ls"}"#.into(),
            }]
        );
        assert_eq!(generated.finish_reason, "tool_calls");
    }

    struct Rewrite {
        endpoint: String,
        veto: bool,
    }

    impl ModelHooks for Rewrite {
        fn request(
            &self,
            _service: &ModelService,
            request: &GenerateRequest,
            next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
        ) -> Result<GenerateRequest, ModelError> {
            if self.veto {
                let mut replaced = request.clone();
                replaced.endpoint = self.endpoint.clone();
                return Ok(replaced);
            }
            let mut effective = next()?;
            effective.endpoint = self.endpoint.clone();
            Ok(effective)
        }
    }

    /// A hook that throws, as 60-hooks installs one on `model/request`.
    struct Broken;

    impl ModelHooks for Broken {
        fn request(
            &self,
            _service: &ModelService,
            request: &GenerateRequest,
            _next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
        ) -> Result<GenerateRequest, ModelError> {
            Err(ModelError::new(
                "a hook failed at model/request (broken) — refused on purpose",
                request.endpoint.clone(),
                "HOOK_FAILED",
            ))
        }
    }

    #[tokio::test]
    async fn a_request_hook_that_fails_fails_the_call_with_its_own_sentence() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [{ "text": "never sent" }] })),
        ])
        .expect("registers");
        service.add_hooks(Arc::new(Broken));
        let error = match service.stream(ask("a")) {
            Ok(_) => panic!("a failing hook fails the call before any stream exists"),
            Err(error) => error,
        };
        assert_eq!(error.code, "HOOK_FAILED");
        assert_eq!(
            error.to_string(),
            "a hook failed at model/request (broken) — refused on purpose"
        );
        let error = service
            .generate(ask("a"))
            .await
            .expect_err("generate fails too");
        assert_eq!(error.code, "HOOK_FAILED");
    }

    #[tokio::test]
    async fn an_inner_hooks_failure_passes_through_an_outer_hook_that_called_next() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [{ "text": "from a" }] })),
            fixture.endpoint("b", json!({ "steps": [{ "text": "from b" }] })),
        ])
        .expect("registers");
        // Outermost first: Rewrite calls next(), which runs Broken, whose failure it propagates.
        service.add_hooks(Arc::new(Rewrite {
            endpoint: "b".into(),
            veto: false,
        }));
        service.add_hooks(Arc::new(Broken));
        let error = service
            .generate(ask("a"))
            .await
            .expect_err("the inner failure wins");
        assert_eq!(error.code, "HOOK_FAILED");
    }

    /// A hook that is not idempotent: it counts its calls and sends the n-th to `a` or `b` by parity.
    struct Alternate {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl ModelHooks for Alternate {
        fn request(
            &self,
            _service: &ModelService,
            _request: &GenerateRequest,
            next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
        ) -> Result<GenerateRequest, ModelError> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut effective = next()?;
            effective.endpoint = if call.is_multiple_of(2) { "a" } else { "b" }.into();
            Ok(effective)
        }
    }

    #[tokio::test]
    async fn a_resolved_request_streams_without_running_the_request_hooks_again() {
        // Issue #14: the loop resolves once, records that request, and streams it; a second pass through a
        // non-idempotent hook would send the call somewhere other than what was recorded.
        let fixture = Fixture::new();
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [{ "text": "from a" }] })),
            fixture.endpoint("b", json!({ "steps": [{ "text": "from b" }] })),
        ])
        .expect("registers");
        let hook = Arc::new(Alternate {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        service.add_hooks(hook.clone());
        let resolved = service.resolve(&ask("b")).expect("resolves");
        assert_eq!(resolved.endpoint, "a", "the first pass sends it to a");
        let mut stream = service.stream_resolved(resolved).expect("streams");
        let mut text = String::new();
        while let Some(chunk) = stream.next().await {
            if let Ok(Chunk::TextDelta { text: delta }) = chunk {
                text.push_str(&delta);
            }
        }
        assert_eq!(
            text, "from a",
            "the call went where the one resolution said"
        );
        assert_eq!(
            hook.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the hook ran once"
        );
    }

    #[tokio::test]
    async fn the_request_hook_can_rewrite_the_request_and_can_veto_the_rest() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [{ "text": "from a" }] })),
            fixture.endpoint("b", json!({ "steps": [{ "text": "from b" }] })),
        ])
        .expect("registers");

        let hooks = service.add_hooks(Arc::new(Rewrite {
            endpoint: "b".into(),
            veto: false,
        }));
        assert_eq!(
            service.generate(ask("a")).await.expect("answers").text,
            "from b",
            "a policy listener sends the call where it says"
        );
        assert!(service.remove_hooks(hooks));
        assert!(!service.remove_hooks(hooks), "removal is by handle");

        service.add_hooks(Arc::new(Rewrite {
            endpoint: "b".into(),
            veto: true,
        }));
        assert_eq!(
            service.generate(ask("a")).await.expect("answers").text,
            "from b",
            "not calling next vetoes the rest and the hook's own request is used"
        );
    }

    struct Prefix;

    impl ModelHooks for Prefix {
        fn stream(
            &self,
            _request: &GenerateRequest,
            next: Box<dyn FnOnce() -> ChunkStream + Send>,
        ) -> ChunkStream {
            Box::pin(
                futures::stream::once(async {
                    Ok(Chunk::TextDelta {
                        text: "pre".to_string(),
                    })
                })
                .chain(next()),
            )
        }
    }

    #[tokio::test]
    async fn the_stream_hook_wraps_the_adapters_stream() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [{ "text": "answer" }] })),
        ])
        .expect("registers");
        service.add_hooks(Arc::new(Prefix));
        assert_eq!(
            service.generate(ask("a")).await.expect("answers").text,
            "preanswer"
        );
    }

    #[tokio::test]
    async fn a_probe_reports_the_answer_and_the_model_it_used() {
        let fixture = Fixture::new();
        let service = ModelService::new(vec![fixture.endpoint_with(
            "a",
            json!({ "steps": [{ "text": "ready" }] }),
            Some("scr"),
        )])
        .expect("registers");
        let probe = service
            .probe("a", ProbeOptions::default())
            .await
            .expect("answers");
        assert_eq!(probe.endpoint, "a");
        assert_eq!(probe.model, Some("scr".to_string()));
        assert_eq!(probe.text, "ready");
        assert_eq!(probe.finish_reason, "stop");
        assert_eq!(
            service
                .probe("missing", ProbeOptions::default())
                .await
                .expect_err("refused")
                .code,
            crate::error::code::NO_ENDPOINT
        );
    }

    #[test]
    fn the_summary_line_names_each_endpoint_without_its_credential() {
        let fixture = Fixture::new();
        let mut credentialed = fixture.endpoint("b", json!({ "steps": [] }));
        credentialed.api_key = Some("secret-value".into());
        let service = ModelService::new(vec![
            fixture.endpoint("a", json!({ "steps": [] })),
            credentialed,
        ])
        .expect("registers");
        assert_eq!(
            service.summary_line(),
            "model: 2 endpoint(s) — a(scripted), b(scripted,credential)"
        );
        assert!(!service.summary_line().contains("secret-value"));
    }

    #[test]
    fn the_discovered_modalities_fill_a_blank_but_never_override_a_declaration() {
        let fixture = Fixture::new();
        let declared = fixture.endpoint("a", json!({ "steps": [] }));
        assert_eq!(
            with_discovered_modalities(&declared, Some(&[InputModality::Image])),
            EndpointConfig {
                input_modalities: Some(vec!["image".into()]),
                ..declared.clone()
            }
        );
        let mut explicit = declared.clone();
        explicit.input_modalities = Some(vec!["text".into()]);
        assert_eq!(
            with_discovered_modalities(&explicit, Some(&[InputModality::Image])),
            explicit
        );
        assert_eq!(with_discovered_modalities(&declared, None), declared);
    }

    #[test]
    fn the_last_assistant_text_is_what_a_transcript_reader_shows() {
        let messages = vec![
            user_message("one"),
            Message::new(
                crate::types::Role::Assistant,
                vec![crate::types::ContentPart::text("first")],
            ),
            user_message("two"),
            Message::new(
                crate::types::Role::Assistant,
                vec![
                    crate::types::ContentPart::reasoning("hm"),
                    crate::types::ContentPart::text("last"),
                ],
            ),
            Message::new(
                crate::types::Role::Tool,
                vec![crate::types::ContentPart::text("ok")],
            ),
        ];
        assert_eq!(last_assistant_text(&messages), "last");
        assert_eq!(last_assistant_text(&[user_message("only")]), "");
    }
}
