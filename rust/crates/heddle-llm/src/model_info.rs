//! What the provider's own model list says about a model: its context window and its input modalities.
//!
//! Ported from `src/llm/model-info.ts`. Rules that carry over:
//!
//! - **Configuration wins.** These are consulted only when the endpoint declares no window / no modalities.
//! - **A missing or failed answer is `None`**: the caller prints a blank or falls back to text only.
//! - **One read per endpoint, address and model**, shared by concurrent callers; only an answer is cached, so one
//!   outage does not stick.
//! - Only the two OpenAI shapes have a list (`GET {address}/models`); rows are `data[]` keyed by `id` on Chat
//!   Completions, `models[]` keyed by `slug` or `id` on Responses. The read goes through the shared client, so an
//!   endpoint reachable only through a forwarding proxy is read through it.

use serde_json::Value;

use heddle_config::{EndpointConfig, EndpointKind};
use serde::{Deserialize, Serialize};

/// What a model accepts: the two input modalities the harness can deliver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputModality {
    Text,
    Image,
}

impl InputModality {
    /// The modality as configuration spells it (`EndpointConfig::input_modalities` holds these strings).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
        }
    }
}

/// Whether a wire shape publishes a model list (`listedKind`): the two OpenAI shapes.
pub fn has_model_list(kind: &EndpointKind) -> bool {
    matches!(
        kind,
        EndpointKind::OpenaiChat | EndpointKind::OpenaiResponses
    )
}

/// How long a model-list read may take before the answer stays `None`.
pub const DEFAULT_MODEL_INFO_TIMEOUT_MS: u64 = 1500;

/// What a read may be told.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelInfoOptions {
    /// [`DEFAULT_MODEL_INFO_TIMEOUT_MS`] when absent.
    pub timeout_ms: Option<u64>,
    /// The model the caller will actually use, when it is not the endpoint's default; its own `baseUrl` is asked.
    pub ask_about: Option<String>,
}

/// The cache of model-list bodies. [`crate::ModelService`] owns one and shares it; a server route that prices the
/// context gauge asks the service's.
#[derive(Debug, Default)]
pub struct ModelListCache {
    lists: tokio::sync::Mutex<std::collections::HashMap<String, Value>>,
}

impl ModelListCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The model's window from the provider's list (`contextWindowFromModelList`): a positive finite
    /// `context_window`, rounded.
    pub async fn context_window(
        &self,
        endpoint: &EndpointConfig,
        options: &ModelInfoOptions,
    ) -> Option<u64> {
        let _ = (endpoint, options, &self.lists);
        todo!("port contextWindowFromModelList")
    }

    /// The model's input modalities from the provider's list (`inputModalitiesFromModelList`).
    pub async fn input_modalities(
        &self,
        endpoint: &EndpointConfig,
        options: &ModelInfoOptions,
    ) -> Option<Vec<InputModality>> {
        let _ = (endpoint, options);
        todo!("port inputModalitiesFromModelList")
    }

    /// Forget cached answers (`resetModelInfoCache`).
    pub async fn reset(&self) {
        self.lists.lock().await.clear();
    }
}

/// One list row for a model, by the wire's id keys (`rowOf`).
pub fn row_of<'a>(body: &'a Value, kind: &EndpointKind, model: &str) -> Option<&'a Value> {
    let _ = (body, kind, model);
    todo!("port rowOf")
}

/// A row's input modalities wherever the provider put them (`inputModalitiesOfRow`): `input_modalities`,
/// `inputModalities`, `architecture.input_modalities`, or `modalities` (an array or an object's `input`). Only
/// `text` and `image` are kept, deduplicated; nothing usable is `None`.
pub fn input_modalities_of_row(row: &Value) -> Option<Vec<InputModality>> {
    let _ = row;
    todo!("port inputModalitiesOfRow")
}
