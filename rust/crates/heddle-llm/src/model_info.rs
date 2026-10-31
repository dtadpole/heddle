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

use std::sync::Arc;

use serde_json::Value;

use heddle_config::{EndpointConfig, EndpointKind, ModelEntry};
use serde::{Deserialize, Serialize};

use crate::http::{Method, WireRequest, WireResponse, wire};

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

/// The model this read is about: the one asked about, else the endpoint's default.
fn asked_about(endpoint: &EndpointConfig, options: &ModelInfoOptions) -> Option<String> {
    options
        .ask_about
        .as_ref()
        .or(endpoint.model.as_ref())
        .filter(|model| !model.is_empty())
        .cloned()
}

/// The address that serves that model: the model's own host when it declares one, else the endpoint's.
fn address_of(endpoint: &EndpointConfig, model: Option<&str>) -> String {
    let declared = model.and_then(|model| {
        endpoint.models.as_ref().and_then(|models| {
            models.iter().find_map(|entry| match entry {
                ModelEntry::Id(id) if id == model => None,
                ModelEntry::Option(option) if option.id == model => option.base_url.clone(),
                _ => None,
            })
        })
    });
    declared.unwrap_or_else(|| endpoint.base_url.clone())
}

/// The cache of model-list bodies. [`crate::ModelService`] owns one and shares it; a server route that prices the
/// context gauge asks the service's.
///
/// A cached entry is a [`tokio::sync::OnceCell`] so concurrent callers share one read, and only an answer is kept:
/// a failed read is removed again, because an outage is not a fact about the model.
#[derive(Debug, Default)]
pub struct ModelListCache {
    lists: tokio::sync::Mutex<
        std::collections::HashMap<String, Arc<tokio::sync::OnceCell<Option<Value>>>>,
    >,
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
        let body = self.model_list(endpoint, options).await?;
        let model = asked_about(endpoint, options)?;
        let reported = row_of(&body, &endpoint.kind, &model)?
            .get("context_window")?
            .as_f64()?;
        if reported.is_finite() && reported > 0.0 {
            Some(reported.round() as u64)
        } else {
            None
        }
    }

    /// The model's input modalities from the provider's list (`inputModalitiesFromModelList`).
    pub async fn input_modalities(
        &self,
        endpoint: &EndpointConfig,
        options: &ModelInfoOptions,
    ) -> Option<Vec<InputModality>> {
        let body = self.model_list(endpoint, options).await?;
        let model = asked_about(endpoint, options)?;
        input_modalities_of_row(row_of(&body, &endpoint.kind, &model)?)
    }

    /// Forget cached answers (`resetModelInfoCache`).
    pub async fn reset(&self) {
        self.lists.lock().await.clear();
    }

    /// The provider's model-list body, read once per endpoint, address and model and shared by both readers.
    async fn model_list(
        &self,
        endpoint: &EndpointConfig,
        options: &ModelInfoOptions,
    ) -> Option<Value> {
        if !has_model_list(&endpoint.kind) {
            return None;
        }
        let model = asked_about(endpoint, options)?;
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            endpoint.name,
            address_of(endpoint, Some(&model)),
            model
        );
        let cell = {
            let mut lists = self.lists.lock().await;
            lists
                .entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
                .clone()
        };
        let answer = cell
            .get_or_init(|| read_model_list(endpoint, &model, options))
            .await
            .clone();
        if answer.is_none() {
            let mut lists = self.lists.lock().await;
            if lists
                .get(&key)
                .is_some_and(|existing| Arc::ptr_eq(existing, &cell))
            {
                lists.remove(&key);
            }
        }
        answer
    }
}

/// One authenticated GET of the provider's model list; every failure is `None`, because a caller's blank is the
/// truthful answer.
async fn read_model_list(
    endpoint: &EndpointConfig,
    model: &str,
    options: &ModelInfoOptions,
) -> Option<Value> {
    let mut headers: Vec<(String, String)> =
        vec![("accept".to_string(), "application/json".to_string())];
    if let Some(configured) = &endpoint.headers {
        headers.extend(
            configured
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
    }
    let api_key = endpoint.api_key.clone().or_else(|| read_key_file(endpoint));
    let request = WireRequest {
        url: format!(
            "{}/models",
            address_of(endpoint, Some(model)).trim_end_matches('/')
        ),
        method: Method::Get,
        headers,
        api_key,
        timeout_ms: Some(options.timeout_ms.unwrap_or(DEFAULT_MODEL_INFO_TIMEOUT_MS)),
        endpoint: endpoint.name.clone(),
        proxy: endpoint.proxy.clone(),
        ..WireRequest::default()
    };
    match wire(request).await {
        Ok(WireResponse::Json(body)) => Some(body),
        _ => None,
    }
}

/// Read a key file the way the endpoint configuration does, but let a missing file mean "no key".
fn read_key_file(endpoint: &EndpointConfig) -> Option<String> {
    let path = endpoint.api_key_file.as_deref()?;
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| std::path::PathBuf::from(home).join(rest))
            .unwrap_or_else(|| std::path::PathBuf::from(path)),
        None => std::path::PathBuf::from(path),
    };
    std::fs::read_to_string(expanded)
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// The list rows for the wire shape.
fn rows_of<'a>(body: &'a Value, kind: &EndpointKind) -> Option<&'a Vec<Value>> {
    let key = match kind {
        EndpointKind::OpenaiChat => "data",
        EndpointKind::OpenaiResponses => "models",
        _ => return None,
    };
    body.get(key).and_then(Value::as_array)
}

/// One list row for a model, by the wire's id keys (`rowOf`).
pub fn row_of<'a>(body: &'a Value, kind: &EndpointKind, model: &str) -> Option<&'a Value> {
    let rows = rows_of(body, kind)?;
    let id_keys: &[&str] = match kind {
        EndpointKind::OpenaiChat => &["id"],
        EndpointKind::OpenaiResponses => &["slug", "id"],
        _ => return None,
    };
    rows.iter().find(|row| {
        row.is_object()
            && id_keys
                .iter()
                .any(|key| row.get(*key).and_then(Value::as_str) == Some(model))
    })
}

/// A row's input modalities wherever the provider put them (`inputModalitiesOfRow`): `input_modalities`,
/// `inputModalities`, `architecture.input_modalities`, or `modalities` (an array or an object's `input`). Only
/// `text` and `image` are kept, deduplicated; nothing usable is `None`.
pub fn input_modalities_of_row(row: &Value) -> Option<Vec<InputModality>> {
    if !row.is_object() {
        return None;
    }
    for key in ["input_modalities", "inputModalities"] {
        if let Some(parsed) = modality_list(row.get(key)) {
            return Some(parsed);
        }
    }
    if let Some(parsed) = modality_list(
        row.get("architecture")
            .and_then(|architecture| architecture.get("input_modalities")),
    ) {
        return Some(parsed);
    }
    modality_list(row.get("modalities"))
}

/// A modality list, from an array or from the `input` of an object, keeping only what can be delivered.
fn modality_list(value: Option<&Value>) -> Option<Vec<InputModality>> {
    let source = match value {
        Some(Value::Array(entries)) => entries,
        Some(Value::Object(object)) => object.get("input").and_then(Value::as_array)?,
        _ => return None,
    };
    let mut modalities: Vec<InputModality> = Vec::new();
    for entry in source.iter().filter_map(Value::as_str) {
        let modality = match entry.to_lowercase().as_str() {
            "text" => InputModality::Text,
            "image" => InputModality::Image,
            _ => continue,
        };
        if !modalities.contains(&modality) {
            modalities.push(modality);
        }
    }
    (!modalities.is_empty()).then_some(modalities)
}

#[cfg(test)]
mod tests {
    use super::*;
    use heddle_config::ModelOption;
    use serde_json::json;

    fn endpoint(kind: EndpointKind, model: &str) -> EndpointConfig {
        EndpointConfig {
            name: "probe".into(),
            kind,
            base_url: "http://127.0.0.1:1".into(),
            model: Some(model.into()),
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
    fn only_the_openai_shapes_publish_a_model_list() {
        assert!(has_model_list(&EndpointKind::OpenaiChat));
        assert!(has_model_list(&EndpointKind::OpenaiResponses));
        assert!(!has_model_list(&EndpointKind::AnthropicVertex));
        assert!(!has_model_list(&EndpointKind::Scripted));
        assert!(!has_model_list(&EndpointKind::Other("x".into())));
    }

    #[test]
    fn a_row_is_found_by_the_id_key_its_wire_shape_uses() {
        let chat = json!({ "data": [
            { "id": "a", "context_window": 8 },
            { "id": "b", "context_window": 16 }
        ] });
        assert_eq!(
            row_of(&chat, &EndpointKind::OpenaiChat, "b").and_then(|row| row.get("context_window")),
            Some(&json!(16))
        );
        assert_eq!(row_of(&chat, &EndpointKind::OpenaiChat, "missing"), None);
        // The Responses shape keys its rows by slug, and falls back to id.
        let responses =
            json!({ "models": [{ "slug": "s", "input_modalities": ["image"] }, { "id": "i" }] });
        assert_eq!(
            row_of(&responses, &EndpointKind::OpenaiResponses, "s").and_then(|row| row.get("slug")),
            Some(&json!("s"))
        );
        assert_eq!(
            row_of(&responses, &EndpointKind::OpenaiResponses, "i").and_then(|row| row.get("id")),
            Some(&json!("i"))
        );
        assert_eq!(row_of(&json!({}), &EndpointKind::OpenaiChat, "a"), None);
    }

    #[test]
    fn modalities_are_read_wherever_the_provider_put_them() {
        let cases = [
            json!({ "input_modalities": ["text", "image"] }),
            json!({ "inputModalities": ["text", "image"] }),
            json!({ "architecture": { "input_modalities": ["text", "image"] } }),
            json!({ "modalities": ["text", "image"] }),
            json!({ "modalities": { "input": ["text", "image"] } }),
        ];
        for row in cases {
            assert_eq!(
                input_modalities_of_row(&row),
                Some(vec![InputModality::Text, InputModality::Image]),
                "{row}"
            );
        }
    }

    #[test]
    fn only_usable_modalities_are_kept_deduplicated_and_lowercased() {
        assert_eq!(
            input_modalities_of_row(
                &json!({ "input_modalities": ["IMAGE", "text", "image", "audio"] })
            ),
            Some(vec![InputModality::Image, InputModality::Text])
        );
        assert_eq!(
            input_modalities_of_row(&json!({ "input_modalities": ["audio"] })),
            None,
            "a value naming nothing deliverable is the same as saying nothing"
        );
        assert_eq!(input_modalities_of_row(&json!({ "id": "m" })), None);
        assert_eq!(input_modalities_of_row(&json!("not a record")), None);
    }

    /// A one-shot HTTP double, answering every request with `reply`.
    struct Server {
        url: String,
        seen: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Server {
        async fn start(reply: impl Fn() -> String + Send + Sync + 'static) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("binds a loopback port");
            let address = listener.local_addr().expect("has an address");
            let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let recorded = seen.clone();
            let reply = std::sync::Arc::new(reply);
            let handle = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let reply = reply.clone();
                    let recorded = recorded.clone();
                    tokio::spawn(async move {
                        let mut buffer = Vec::new();
                        let mut read = [0u8; 1024];
                        while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                            match socket.read(&mut read).await {
                                Ok(0) | Err(_) => break,
                                Ok(count) => buffer.extend_from_slice(&read[..count]),
                            }
                        }
                        recorded.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let body = reply();
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                    });
                }
            });
            Self {
                url: format!("http://{address}"),
                seen,
                handle,
            }
        }

        fn requests(&self) -> usize {
            self.seen.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    #[tokio::test]
    async fn the_context_window_comes_from_the_providers_list_and_the_read_is_shared() {
        let server = Server::start(|| {
            json!({ "data": [{ "id": "m", "context_window": 8192.4 }] }).to_string()
        })
        .await;
        let cache = ModelListCache::new();
        let mut endpoint = endpoint(EndpointKind::OpenaiChat, "m");
        endpoint.base_url = server.url.clone();
        assert_eq!(
            cache
                .context_window(&endpoint, &ModelInfoOptions::default())
                .await,
            Some(8192),
            "a positive window is rounded"
        );
        assert_eq!(
            cache
                .context_window(&endpoint, &ModelInfoOptions::default())
                .await,
            Some(8192)
        );
        assert_eq!(server.requests(), 1, "one read serves both callers");
        cache.reset().await;
        assert_eq!(
            cache
                .context_window(&endpoint, &ModelInfoOptions::default())
                .await,
            Some(8192)
        );
        assert_eq!(server.requests(), 2, "reset forgets the answer");
    }

    #[tokio::test]
    async fn the_input_modalities_come_from_the_list_too() {
        let server = Server::start(|| {
            json!({ "models": [{ "slug": "m", "input_modalities": ["text", "image"] }] })
                .to_string()
        })
        .await;
        let cache = ModelListCache::new();
        let mut endpoint = endpoint(EndpointKind::OpenaiResponses, "m");
        endpoint.base_url = server.url.clone();
        assert_eq!(
            cache
                .input_modalities(&endpoint, &ModelInfoOptions::default())
                .await,
            Some(vec![InputModality::Text, InputModality::Image])
        );
    }

    #[tokio::test]
    async fn a_failed_read_is_not_cached() {
        let server = Server::start(|| "not a list".to_string()).await;
        let cache = ModelListCache::new();
        let mut endpoint = endpoint(EndpointKind::OpenaiChat, "m");
        endpoint.base_url = server.url.clone();
        assert_eq!(
            cache
                .context_window(&endpoint, &ModelInfoOptions::default())
                .await,
            None
        );
        assert_eq!(
            cache
                .context_window(&endpoint, &ModelInfoOptions::default())
                .await,
            None
        );
        assert_eq!(
            server.requests(),
            2,
            "one outage does not stick: the next caller asks again"
        );
    }

    #[tokio::test]
    async fn an_unlisted_kind_asks_nothing() {
        let server = Server::start(|| json!({ "data": [] }).to_string()).await;
        let cache = ModelListCache::new();
        let mut endpoint = endpoint(EndpointKind::AnthropicVertex, "m");
        endpoint.base_url = server.url.clone();
        assert_eq!(
            cache
                .context_window(&endpoint, &ModelInfoOptions::default())
                .await,
            None
        );
        assert_eq!(server.requests(), 0);
    }

    #[tokio::test]
    async fn the_model_asked_about_is_read_from_its_own_address() {
        let server = Server::start(|| {
            json!({ "data": [{ "id": "other", "context_window": 1000 }] }).to_string()
        })
        .await;
        let cache = ModelListCache::new();
        let mut endpoint = endpoint(EndpointKind::OpenaiChat, "default");
        // The endpoint's own address is dead; the model declares the host that serves it.
        endpoint.models = Some(vec![ModelEntry::Option(ModelOption {
            id: "other".into(),
            base_url: Some(server.url.clone()),
            ..ModelOption::default()
        })]);
        let options = ModelInfoOptions {
            ask_about: Some("other".into()),
            ..ModelInfoOptions::default()
        };
        assert_eq!(cache.context_window(&endpoint, &options).await, Some(1000));
        assert_eq!(server.requests(), 1);
    }
}
