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
use std::sync::atomic::AtomicU64;

use serde::Serialize;

use crate::adapter::{Adapter, ChunkStream};
use heddle_config::EndpointConfig;

use crate::error::ModelError;
use crate::model_info::InputModality;
use crate::model_info::ModelListCache;
use crate::types::{GenerateRequest, Message, ToolCall};

/// The waterfall over a request before an adapter is chosen.
pub const HOOK_MODEL_REQUEST: &str = "model/request";
/// The waterfall around every adapter stream.
pub const HOOK_MODEL_STREAM: &str = "model/stream";

/// The `model/request` and `model/stream` interception points. Both default to passing through.
pub trait ModelHooks: Send + Sync {
    /// `model/request`: return a replacement request (how a model-selection policy works), or `next()`'s result.
    /// `service` is the service dispatching, for `names()` / `endpoint()` lookups.
    fn request(
        &self,
        service: &ModelService,
        request: &GenerateRequest,
        next: &mut dyn FnMut() -> GenerateRequest,
    ) -> GenerateRequest {
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

/// The model service. Shared as `Arc<ModelService>`; every method takes `&self`.
pub struct ModelService {
    adapters: std::sync::RwLock<Vec<Arc<dyn Adapter>>>,
    nominated: std::sync::RwLock<Option<String>>,
    hooks: std::sync::RwLock<Vec<(HooksId, Arc<dyn ModelHooks>)>>,
    next_hooks_id: AtomicU64,
    model_lists: Arc<ModelListCache>,
}

impl ModelService {
    /// A service holding these endpoints, in this order. `UNKNOWN_KIND` for an endpoint no adapter speaks.
    pub fn new(endpoints: Vec<EndpointConfig>) -> Result<Self, ModelError> {
        let _ = endpoints;
        todo!("port the ModelService constructor")
    }

    /// The model plugin's composition (`plugins/model.ts`): the resolved endpoint list plus the nominated default,
    /// recorded only when it names an endpoint that exists.
    pub fn from_configuration(
        endpoints: Vec<EndpointConfig>,
        nominated: Option<&str>,
    ) -> Result<Self, ModelError> {
        let _ = (endpoints, nominated);
        todo!("port plugins/model.ts")
    }

    /// The plugin's log line: `model: N endpoint(s) — name(kind[,credential]), …`. No credential value appears.
    pub fn summary_line(&self) -> String {
        todo!("port the plugin's info line")
    }

    /// Add an endpoint, replacing one of the same name in place; its discovered modalities are dropped with it.
    pub fn register(&self, endpoint: EndpointConfig) -> Result<(), ModelError> {
        let _ = endpoint;
        todo!("port register")
    }

    /// Every endpoint, in declaration order (`list`).
    pub fn list(&self) -> Vec<EndpointConfig> {
        todo!("port list")
    }

    /// The endpoints' names, which is what `--endpoint` accepts (`names`).
    pub fn names(&self) -> Vec<String> {
        todo!("port names")
    }

    /// One endpoint's configuration (`endpoint`).
    pub fn endpoint(&self, name: &str) -> Option<EndpointConfig> {
        let _ = name;
        todo!("port endpoint")
    }

    /// The endpoint a caller means when it names none (`defaultEndpoint`): `nominated` if given and present, else
    /// the configuration's nominated default if present, else the first endpoint.
    pub fn default_endpoint(&self, nominated: Option<&str>) -> Option<String> {
        let _ = nominated;
        todo!("port defaultEndpoint")
    }

    /// Record the configuration's default, if it names an endpoint that exists (`nominateDefault`).
    pub fn nominate_default(&self, name: &str) {
        let _ = name;
        todo!("port nominateDefault")
    }

    /// The recorded default, if any. The composer's endpoint listing reports it.
    pub fn nominated(&self) -> Option<String> {
        todo!("read the nominated default")
    }

    /// Register `model/request` / `model/stream` hooks, after (inside) every hook already registered.
    pub fn add_hooks(&self, hooks: Arc<dyn ModelHooks>) -> HooksId {
        let _ = (hooks, &self.hooks, &self.next_hooks_id);
        todo!("register hooks")
    }

    /// Remove hooks by handle; `false` when they were not registered.
    pub fn remove_hooks(&self, id: HooksId) -> bool {
        let _ = id;
        todo!("unregister hooks")
    }

    /// The model-list cache this service reads through, for a caller that prices a context window.
    pub fn model_lists(&self) -> &Arc<ModelListCache> {
        &self.model_lists
    }

    /// Call one endpoint and stream the answer (`stream`). `NO_ENDPOINT` is returned before any stream exists.
    pub fn stream(&self, request: GenerateRequest) -> Result<ChunkStream, ModelError> {
        let _ = (request, &self.adapters, &self.nominated);
        todo!("port stream")
    }

    /// One call, collected — the same stream, folded (`generate`).
    pub async fn generate(&self, request: GenerateRequest) -> Result<Generated, ModelError> {
        let _ = request;
        todo!("port generate")
    }

    /// The cheapest call that proves an endpoint answers: one user turn, a 16-token cap, no tools (`probe`).
    pub async fn probe(
        &self,
        endpoint: &str,
        options: ProbeOptions,
    ) -> Result<ProbeResult, ModelError> {
        let _ = (endpoint, options);
        todo!("port probe")
    }
}

/// The endpoint with the modalities a provider published, when it declared none (`withDiscoveredModalities`).
pub fn with_discovered_modalities(
    endpoint: &EndpointConfig,
    discovered: Option<&[InputModality]>,
) -> EndpointConfig {
    let _ = (endpoint, discovered);
    todo!("port withDiscoveredModalities")
}

/// The last assistant message's text, for a transcript reader (`lastAssistantText`).
pub fn last_assistant_text(messages: &[Message]) -> String {
    let _ = messages;
    todo!("port lastAssistantText")
}
