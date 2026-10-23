//! Endpoint configuration: what an endpoint is, its model catalogue, and the ladder that resolves it.
//!
//! Ported from `src/endpoints.ts`, and from the configuration half of `src/llm/types.ts`
//! (`EndpointConfig`, `ModelOption`, `ReasoningLevel(s)` and the catalogue functions
//! `offeredModels` … `reasoningLevelFor`). They live here rather than in `heddle-llm` because the
//! dependency runs `heddle-llm → heddle-config`: an endpoint is configuration, and the adapters,
//! the model service and the composer routes all read the same type.
//!
//! The ladder answers "how does a harness talk to a paid gateway without committing anything": the
//! repository carries the **shape**, the machine carries the **values**. In order, each step overriding
//! the one before: the model component's own configuration (a layer file); the local file
//! ([`crate::read_local_config`]); the environment, `HEDDLE_<ENDPOINT>_BASE_URL`, `_MODEL`, `_API_KEY`,
//! `_API_KEY_FILE`, `_KIND`. A secret is only ever read from a path or a variable, and never printed.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};

use crate::env::Env;
use crate::error::ConfigError;
use crate::home::{expand_home, heddle_home};

/// Which wire shape an endpoint speaks.
///
/// Serialized as its string. A kind no variant names is kept as [`EndpointKind::Other`] rather than
/// refused while reading, because the TypeScript build carried kinds as strings and refused an unknown
/// one only when an adapter was asked for it — `heddle-llm` decides that, not the reader.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum EndpointKind {
    /// `openai-chat` — Chat Completions.
    OpenaiChat,
    /// `openai-responses` — the Responses API.
    OpenaiResponses,
    /// `anthropic-vertex` — Anthropic models on a publisher route; needs `project` and `region`.
    AnthropicVertex,
    /// `scripted` — the offline endpoint that replays a local JSON file.
    Scripted,
    /// Any other string.
    Other(String),
}

impl EndpointKind {
    /// The kind as configuration spells it.
    pub fn as_str(&self) -> &str {
        match self {
            EndpointKind::OpenaiChat => "openai-chat",
            EndpointKind::OpenaiResponses => "openai-responses",
            EndpointKind::AnthropicVertex => "anthropic-vertex",
            EndpointKind::Scripted => "scripted",
            EndpointKind::Other(other) => other,
        }
    }

    /// The kind a string spells; never fails.
    pub fn parse(text: &str) -> Self {
        match text {
            "openai-chat" => EndpointKind::OpenaiChat,
            "openai-responses" => EndpointKind::OpenaiResponses,
            "anthropic-vertex" => EndpointKind::AnthropicVertex,
            "scripted" => EndpointKind::Scripted,
            other => EndpointKind::Other(other.to_string()),
        }
    }
}

impl fmt::Display for EndpointKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Default for EndpointKind {
    /// No kind yet — the state a patch-read endpoint starts in before its kind is applied. It is
    /// never a usable endpoint: [`resolve_endpoints`] refuses one without a kind.
    fn default() -> Self {
        EndpointKind::Other(String::new())
    }
}

impl Serialize for EndpointKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EndpointKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Ok(EndpointKind::parse(&text))
    }
}

/// The value a reasoning level sends on the wire: a string or a number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReasoningValue {
    /// `"high"`.
    Text(String),
    /// `8192`.
    Number(Number),
}

/// One reasoning level: an id, a name a person reads, and the value the provider's wire expects.
///
/// `value: None` (written `null`) is a level that is real and displayed but sends no parameter — the
/// provider's own default. The value never reaches a page; only an adapter reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningLevel {
    /// The level's id, which a session records and a page sends back.
    pub id: String,
    /// The name a person reads.
    pub name: String,
    /// The wire value, or `None` for "send nothing".
    #[serde(default)]
    pub value: Option<ReasoningValue>,
}

/// The levels a model offers, and the one it uses when nobody chose.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningLevels {
    /// The level used when a session recorded none; absent means the provider's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// The levels, in the order a menu shows them.
    pub levels: Vec<ReasoningLevel>,
}

/// One model type an endpoint offers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    /// The model id sent on the wire.
    pub id: String,
    /// The name a person reads; the id when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// This model's levels, which **replace** (never merge with) the endpoint's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevels>,
    /// The gateway this model is served from, when the endpoint's models do not share one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// This model's context window in tokens, when it differs from the endpoint's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// One entry of an endpoint's `models`: a bare id, or a full option. `["a"]` and `[{ id: a }]` mean the
/// same thing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelEntry {
    /// `"deepseek-flash"`.
    Id(String),
    /// `{ id: deepseek-flash, name: DeepSeek-V4.1-Flash, reasoning: … }`.
    Option(ModelOption),
}

/// What an adapter is told about its endpoint. Keys are camelCase on the wire, as in the TypeScript
/// build, so the same `heddle.json` serves both builds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointConfig {
    /// The stable name a request addresses this endpoint by.
    pub name: String,
    /// Which wire shape it speaks.
    pub kind: EndpointKind,
    /// Scheme, host and path prefix, without a trailing slash.
    pub base_url: String,
    /// The default model id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The model types offered, in the user's order; absent means just `model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelEntry>>,
    /// Levels for every model that declares none of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevels>,
    /// The cloud project of a publisher route; required by `anthropic-vertex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The region of that project's endpoint; required by `anthropic-vertex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// Sent as a bearer token. Never logged, never printed, never committed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// A file to read the token from (`~` expanded), resolved into `api_key` by the ladder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_file: Option<String>,
    /// Extra headers, for a gateway that gates on its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    /// Force streaming on or off regardless of the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// Default cap on generated tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// The context window in tokens, when this route knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// What this endpoint can do (`offline`, `tools`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    /// What input the model accepts, `text` and `image`; absent means text only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    /// An HTTP forwarding proxy, as a URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    /// Milliseconds before a request is abandoned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// A partial endpoint: what a layer, the local file or the environment restates. Every field optional;
/// a present field overrides, as `Object.assign` did. Each field means what [`EndpointConfig`]'s field of
/// the same name means.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<EndpointKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevels>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl EndpointConfig {
    /// The model types offered (`offeredModels`): `models` normalised (a bare id becomes an option, an
    /// entry whose id is blank is dropped), else the single `model` when non-empty, else none.
    pub fn offered_models(&self) -> Vec<ModelOption> {
        match &self.models {
            Some(entries) => entries
                .iter()
                .filter_map(|entry| {
                    let option = match entry {
                        ModelEntry::Id(id) => ModelOption {
                            id: id.clone(),
                            ..ModelOption::default()
                        },
                        ModelEntry::Option(option) => option.clone(),
                    };
                    (!option.id.trim().is_empty()).then_some(option)
                })
                .collect(),
            None => match &self.model {
                Some(model) if !model.is_empty() => vec![ModelOption {
                    id: model.clone(),
                    ..ModelOption::default()
                }],
                _ => Vec::new(),
            },
        }
    }

    /// The catalogue entry `model_id` names (`modelOptionOf`); `None` for `None` or an unoffered id.
    pub fn model_option(&self, model_id: Option<&str>) -> Option<ModelOption> {
        let id = model_id?;
        self.offered_models()
            .into_iter()
            .find(|model| model.id == id)
    }

    /// Where a request for `model_id` (the default model when `None`) is sent (`baseUrlFor`): the
    /// model's own `baseUrl`, else the endpoint's.
    pub fn base_url_for(&self, model_id: Option<&str>) -> String {
        self.model_option(model_id.or(self.model.as_deref()))
            .and_then(|model| model.base_url)
            .unwrap_or_else(|| self.base_url.clone())
    }

    /// The context window of the model a request would use (`contextWindowFor`): the model's, else the
    /// endpoint's.
    pub fn context_window_for(&self, model_id: Option<&str>) -> Option<u64> {
        self.model_option(model_id.or(self.model.as_deref()))
            .and_then(|model| model.context_window)
            .or(self.context_window)
    }

    /// The levels a model offers (`reasoningLevelsFor`): its own block, else the endpoint's, else none.
    /// `None` means the default model.
    pub fn reasoning_levels_for(&self, model_id: Option<&str>) -> Option<ReasoningLevels> {
        self.model_option(model_id.or(self.model.as_deref()))
            .and_then(|model| model.reasoning)
            .or_else(|| self.reasoning.clone())
    }

    /// One declared level of one model, by id (`reasoningLevelFor`).
    pub fn reasoning_level_for(
        &self,
        model_id: Option<&str>,
        effort_id: &str,
    ) -> Option<ReasoningLevel> {
        self.reasoning_levels_for(model_id)?
            .levels
            .into_iter()
            .find(|level| level.id == effort_id)
    }
}

/// The repository's own endpoints: only `scripted`, which is offline (`kind: scripted`,
/// `baseUrl: scripted.json`, `model: scripted`, `capabilities: [offline, tools]`). Nothing here points
/// at a paid service or carries a credential.
pub fn default_endpoints() -> Vec<EndpointConfig> {
    vec![EndpointConfig {
        name: "scripted".into(),
        kind: EndpointKind::Scripted,
        base_url: "scripted.json".into(),
        model: Some("scripted".into()),
        capabilities: Some(vec!["offline".into(), "tools".into()]),
        ..EndpointConfig::default()
    }]
}

/// `configPaths` from `src/endpoints.ts`: `[$HEDDLE_CONFIG]` when it is non-empty, else
/// `[$HEDDLE_HOME/heddle.json, ~/.heddle/heddle.json]`. The TypeScript build defined it and called it
/// nowhere — [`crate::local_config_candidates`] is the rule a run uses — so it is ported for parity
/// only.
pub fn config_paths(env: &Env) -> Vec<PathBuf> {
    if let Some(path) = env.non_empty("HEDDLE_CONFIG") {
        return vec![PathBuf::from(path)];
    }
    vec![
        heddle_home(env).join("heddle.json"),
        env.home_dir().join(".heddle/heddle.json"),
    ]
}

/// The environment's overrides for the endpoint `name`: `HEDDLE_<NAME>_BASE_URL`, `_MODEL`, `_API_KEY`,
/// `_API_KEY_FILE` and `_KIND`, where `<NAME>` is the name upper-cased with every character outside
/// `A-Z0-9` replaced by `_`. An empty variable is not an override.
pub fn environment_override(name: &str, env: &Env) -> EndpointPatch {
    let prefix: String = format!("HEDDLE_{}_", name.to_uppercase())
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    let read = |suffix: &str| {
        env.non_empty(&format!("{prefix}{suffix}"))
            .map(str::to_string)
    };
    EndpointPatch {
        base_url: read("BASE_URL"),
        model: read("MODEL"),
        api_key: read("API_KEY"),
        api_key_file: read("API_KEY_FILE"),
        kind: read("KIND").map(|kind| EndpointKind::parse(&kind)),
        ..EndpointPatch::default()
    }
}

/// `base` with each patch applied in order, every present field overriding (`mergeEndpoint`).
pub fn merge_endpoint(base: &EndpointConfig, patches: &[EndpointPatch]) -> EndpointConfig {
    let mut endpoint = base.clone();
    for patch in patches {
        apply_patch(&mut endpoint, patch);
    }
    endpoint
}

/// Apply every field `patch` names, leaving the rest of `endpoint` alone — `Object.assign`'s rule.
fn apply_patch(endpoint: &mut EndpointConfig, patch: &EndpointPatch) {
    if let Some(value) = &patch.name {
        endpoint.name = value.clone();
    }
    if let Some(value) = &patch.kind {
        endpoint.kind = value.clone();
    }
    if let Some(value) = &patch.base_url {
        endpoint.base_url = value.clone();
    }
    if let Some(value) = &patch.model {
        endpoint.model = Some(value.clone());
    }
    if let Some(value) = &patch.models {
        endpoint.models = Some(value.clone());
    }
    if let Some(value) = &patch.reasoning {
        endpoint.reasoning = Some(value.clone());
    }
    if let Some(value) = &patch.project {
        endpoint.project = Some(value.clone());
    }
    if let Some(value) = &patch.region {
        endpoint.region = Some(value.clone());
    }
    if let Some(value) = &patch.api_key {
        endpoint.api_key = Some(value.clone());
    }
    if let Some(value) = &patch.api_key_file {
        endpoint.api_key_file = Some(value.clone());
    }
    if let Some(value) = &patch.headers {
        endpoint.headers = Some(value.clone());
    }
    if let Some(value) = patch.stream {
        endpoint.stream = Some(value);
    }
    if let Some(value) = patch.max_output_tokens {
        endpoint.max_output_tokens = Some(value);
    }
    if let Some(value) = patch.context_window {
        endpoint.context_window = Some(value);
    }
    if let Some(value) = &patch.capabilities {
        endpoint.capabilities = Some(value.clone());
    }
    if let Some(value) = &patch.input_modalities {
        endpoint.input_modalities = Some(value.clone());
    }
    if let Some(value) = &patch.proxy {
        endpoint.proxy = Some(value.clone());
    }
    if let Some(value) = patch.timeout_ms {
        endpoint.timeout_ms = Some(value);
    }
}

/// The trimmed contents of a key file (`~` expanded), or an error naming the **setting's path, never
/// any part of the value**: `could not read the key file '{path}': {why}`, or
/// `the key file '{path}' is empty`.
pub fn read_key_file(path: &str, env: &Env) -> Result<String, ConfigError> {
    let expanded = expand_home(path, env);
    let raw = std::fs::read_to_string(&expanded).map_err(|error| {
        ConfigError::one(format!("could not read the key file '{path}': {error}"))
    })?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ConfigError::one(format!("the key file '{path}' is empty")));
    }
    Ok(trimmed.to_string())
}

/// `endpoint` with `api_key_file` read into `api_key`, unless `api_key` is already set or no file is
/// named.
pub fn materialize_key(endpoint: EndpointConfig, env: &Env) -> Result<EndpointConfig, ConfigError> {
    if endpoint
        .api_key
        .as_deref()
        .is_some_and(|key| !key.is_empty())
    {
        return Ok(endpoint);
    }
    let Some(file) = endpoint
        .api_key_file
        .as_deref()
        .filter(|file| !file.is_empty())
        .map(str::to_string)
    else {
        return Ok(endpoint);
    };
    let mut endpoint = endpoint;
    endpoint.api_key = Some(read_key_file(&file, env)?);
    Ok(endpoint)
}

/// The endpoint list a run uses (`resolveEndpoints`).
///
/// Starts from [`default_endpoints`]; applies every `configured` patch, then every `local` one. A patch
/// naming an existing endpoint is merged over it **with that name's environment override on top**; a
/// patch naming a new endpoint must carry a `kind` and a `baseUrl` (`endpoint 'x' needs a kind`) and is
/// added as written. Every patch needs a `name` (`every endpoint needs a name`). Key files are then read,
/// `exclude` names are dropped, and the list is **sorted by name** in code-unit order, so where an
/// endpoint appears never depends on which file mentioned it.
pub fn resolve_endpoints(
    configured: &[EndpointPatch],
    local: &[EndpointPatch],
    env: &Env,
    exclude: &[String],
) -> Result<Vec<EndpointConfig>, ConfigError> {
    let mut by_name: BTreeMap<String, EndpointConfig> = default_endpoints()
        .into_iter()
        .map(|endpoint| (endpoint.name.clone(), endpoint))
        .collect();

    for patch in configured {
        apply_endpoint(&mut by_name, patch, env)?;
    }
    for patch in local {
        apply_endpoint(&mut by_name, patch, env)?;
    }
    for endpoint in by_name.values_mut() {
        if endpoint.api_key_file.is_some() {
            *endpoint = materialize_key(endpoint.clone(), env)?;
        }
    }
    for name in exclude {
        by_name.remove(name);
    }
    Ok(by_name.into_values().collect())
}

/// One patch of [`resolve_endpoints`]: merge over a known endpoint, or add a complete new one.
fn apply_endpoint(
    by_name: &mut BTreeMap<String, EndpointConfig>,
    patch: &EndpointPatch,
    env: &Env,
) -> Result<(), ConfigError> {
    let Some(name) = patch.name.as_deref().filter(|name| !name.is_empty()) else {
        return Err(ConfigError::one("every endpoint needs a name"));
    };
    if let Some(base) = by_name.get(name) {
        let merged = merge_endpoint(base, &[patch.clone(), environment_override(name, env)]);
        by_name.insert(name.to_string(), merged);
        return Ok(());
    }
    if patch.kind.is_none() {
        return Err(ConfigError::one(format!("endpoint '{name}' needs a kind")));
    }
    if patch.base_url.as_deref().is_none_or(str::is_empty) {
        return Err(ConfigError::one(format!(
            "endpoint '{name}' needs a baseUrl"
        )));
    }
    let mut endpoint = EndpointConfig::default();
    apply_patch(&mut endpoint, patch);
    by_name.insert(name.to_string(), endpoint);
    Ok(())
}

/// The endpoint list as the Web UI's switcher reads it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EndpointsView {
    /// [`describe_endpoint`] of each endpoint, in list order.
    pub endpoints: Vec<Value>,
    /// The nominated endpoint when it is in the list, else `null`.
    pub default: Option<String>,
}

/// [`describe_endpoint`] over `endpoints`, with `nominated` kept only when the list holds it.
pub fn describe_endpoints(endpoints: &[EndpointConfig], nominated: Option<&str>) -> EndpointsView {
    let present =
        nominated.is_some_and(|name| endpoints.iter().any(|endpoint| endpoint.name == name));
    EndpointsView {
        endpoints: endpoints.iter().map(describe_endpoint).collect(),
        default: if present {
            nominated.map(str::to_string)
        } else {
            None
        },
    }
}

/// A credential-free summary of an endpoint, safe to log or print: `name`, `kind`, `baseUrl`, `model`,
/// `models` (always present, each `{ id, name, reasoning?, contextWindow? }` with levels by id and name
/// only), `reasoning`, `project`, `region`, `proxy`, `capabilities`, `inputModalities`,
/// `contextWindow` with `contextWindowSource: "config"`, `credential: "set"` for a present key,
/// `credentialFile` for a key file's path, and `headers` as names only. Absent fields are left out.
pub fn describe_endpoint(endpoint: &EndpointConfig) -> Value {
    let mut map = Map::new();
    map.insert("name".into(), Value::String(endpoint.name.clone()));
    map.insert(
        "kind".into(),
        Value::String(endpoint.kind.as_str().to_string()),
    );
    map.insert("baseUrl".into(), Value::String(endpoint.base_url.clone()));
    if let Some(model) = &endpoint.model {
        map.insert("model".into(), Value::String(model.clone()));
    }
    map.insert(
        "models".into(),
        Value::Array(
            endpoint
                .offered_models()
                .iter()
                .map(|model| describe_model(endpoint, model))
                .collect(),
        ),
    );
    if let Some(reasoning) = &endpoint.reasoning {
        map.insert("reasoning".into(), describe_reasoning(reasoning));
    }
    if let Some(project) = &endpoint.project {
        map.insert("project".into(), Value::String(project.clone()));
    }
    if let Some(region) = &endpoint.region {
        map.insert("region".into(), Value::String(region.clone()));
    }
    if let Some(proxy) = &endpoint.proxy {
        map.insert("proxy".into(), Value::String(proxy.clone()));
    }
    if let Some(capabilities) = &endpoint.capabilities {
        map.insert(
            "capabilities".into(),
            serde_json::to_value(capabilities).unwrap_or(Value::Null),
        );
    }
    if let Some(modalities) = &endpoint.input_modalities {
        map.insert(
            "inputModalities".into(),
            serde_json::to_value(modalities).unwrap_or(Value::Null),
        );
    }
    if let Some(window) = endpoint.context_window {
        map.insert("contextWindow".into(), Value::Number(Number::from(window)));
        map.insert("contextWindowSource".into(), Value::String("config".into()));
    }
    if endpoint.api_key.is_some() {
        map.insert("credential".into(), Value::String("set".into()));
    }
    if let Some(file) = &endpoint.api_key_file {
        map.insert("credentialFile".into(), Value::String(file.clone()));
    }
    if let Some(headers) = &endpoint.headers {
        map.insert(
            "headers".into(),
            Value::Array(
                headers
                    .keys()
                    .map(|key| Value::String(key.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(map)
}

/// One model type as a page reads it: id, display name, and effort ids and names.
fn describe_model(endpoint: &EndpointConfig, model: &ModelOption) -> Value {
    let mut map = Map::new();
    map.insert("id".into(), Value::String(model.id.clone()));
    map.insert(
        "name".into(),
        Value::String(model.name.clone().unwrap_or_else(|| model.id.clone())),
    );
    let reasoning = model
        .reasoning
        .clone()
        .or_else(|| endpoint.reasoning.clone());
    if let Some(reasoning) = &reasoning {
        map.insert("reasoning".into(), describe_reasoning(reasoning));
    }
    let context_window = model.context_window.or(endpoint.context_window);
    if let Some(window) = context_window {
        map.insert("contextWindow".into(), Value::Number(Number::from(window)));
    }
    Value::Object(map)
}

/// The effort ladder a page may show, without the provider's wire values.
fn describe_reasoning(reasoning: &ReasoningLevels) -> Value {
    let mut map = Map::new();
    if let Some(default) = &reasoning.default {
        map.insert("default".into(), Value::String(default.clone()));
    }
    map.insert(
        "levels".into(),
        Value::Array(
            reasoning
                .levels
                .iter()
                .map(|level| serde_json::json!({ "id": level.id, "name": level.name }))
                .collect(),
        ),
    );
    Value::Object(map)
}

/// Why a model and effort a page asked for are not offered by `endpoint`, or `None` when they are.
///
/// `model` absent or empty means the endpoint's default; `effort` absent or empty is always acceptable.
/// The sentences name what was asked and what is declared:
/// `no model named 'x' on endpoint 'e'; configured: a, b` (or `(none)`),
/// `model 'm' on endpoint 'e' declares no reasoning effort levels`,
/// `no reasoning effort named 'x' for model 'm' on endpoint 'e'; declared: low, high`.
pub fn selection_problem(
    endpoint: &EndpointConfig,
    model: Option<&str>,
    effort: Option<&str>,
) -> Option<String> {
    let offered = endpoint.offered_models();
    let chosen = match model.filter(|model| !model.is_empty()) {
        Some(model) => Some(model),
        None => endpoint.model.as_deref(),
    };
    if let Some(model) = model.filter(|model| !model.is_empty())
        && !offered.iter().any(|entry| entry.id == model)
    {
        let names: Vec<&str> = offered.iter().map(|entry| entry.id.as_str()).collect();
        let configured = if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        };
        return Some(format!(
            "no model named '{model}' on endpoint '{}'; configured: {configured}",
            endpoint.name
        ));
    }
    let effort = effort.filter(|effort| !effort.is_empty())?;
    let chosen_label = chosen.unwrap_or("(none)");
    let Some(levels) = endpoint.reasoning_levels_for(chosen) else {
        return Some(format!(
            "model '{chosen_label}' on endpoint '{}' declares no reasoning effort levels",
            endpoint.name
        ));
    };
    if !levels.levels.iter().any(|level| level.id == effort) {
        let declared: Vec<&str> = levels
            .levels
            .iter()
            .map(|level| level.id.as_str())
            .collect();
        return Some(format!(
            "no reasoning effort named '{effort}' for model '{chosen_label}' on endpoint '{}'; declared: {}",
            endpoint.name,
            declared.join(", ")
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_endpoint_reads_the_typescript_keys() {
        let endpoint: EndpointConfig = serde_json::from_value(json!({
            "name": "publisher", "kind": "anthropic-vertex", "baseUrl": "http://127.0.0.1:9",
            "project": "a-project", "region": "global", "model": "a-model", "maxOutputTokens": 64,
            "models": ["a-model", { "id": "b", "name": "B", "contextWindow": 1000 }]
        }))
        .unwrap();
        assert_eq!(endpoint.kind, EndpointKind::AnthropicVertex);
        assert_eq!(endpoint.max_output_tokens, Some(64));
        assert_eq!(
            endpoint.models.as_ref().unwrap()[0],
            ModelEntry::Id("a-model".into())
        );
        let back = serde_json::to_value(&endpoint).unwrap();
        assert_eq!(back["baseUrl"], json!("http://127.0.0.1:9"));
        assert_eq!(back["models"][1]["contextWindow"], json!(1000));
    }

    #[test]
    fn an_unknown_kind_is_kept_not_refused() {
        let kind: EndpointKind = serde_json::from_value(json!("future-wire")).unwrap();
        assert_eq!(kind, EndpointKind::Other("future-wire".into()));
        assert_eq!(serde_json::to_value(&kind).unwrap(), json!("future-wire"));
        assert_eq!(EndpointKind::parse("openai-chat").as_str(), "openai-chat");
    }

    #[test]
    fn a_null_reasoning_value_means_send_nothing() {
        let level: ReasoningLevel =
            serde_json::from_value(json!({ "id": "default", "name": "Default", "value": null }))
                .unwrap();
        assert_eq!(level.value, None);
        let high: ReasoningLevel =
            serde_json::from_value(json!({ "id": "high", "name": "High", "value": "high" }))
                .unwrap();
        assert_eq!(high.value, Some(ReasoningValue::Text("high".into())));
    }

    fn endpoint() -> EndpointConfig {
        serde_json::from_value(json!({
            "name": "gateway",
            "kind": "openai-chat",
            "baseUrl": "http://default/v1",
            "model": "a",
            "models": [
                "a",
                {
                    "id": "b",
                    "name": "Bee",
                    "baseUrl": "http://b/v1",
                    "contextWindow": 2000,
                    "reasoning": {
                        "default": "low",
                        "levels": [{ "id": "low", "name": "Low", "value": "low" }]
                    }
                }
            ],
            "reasoning": { "levels": [{ "id": "off", "name": "Off", "value": null }] },
            "contextWindow": 1000
        }))
        .unwrap()
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "heddle-config-endpoints-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn offered_models_normalises_the_catalogue() {
        let endpoint = endpoint();
        assert_eq!(
            endpoint
                .offered_models()
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(
            endpoint.model_option(Some("b")).unwrap().name.as_deref(),
            Some("Bee")
        );
        assert!(endpoint.model_option(Some("nowhere")).is_none());
        assert!(endpoint.model_option(None).is_none());

        let fallback: EndpointConfig = serde_json::from_value(
            json!({ "name": "e", "kind": "scripted", "baseUrl": "x", "model": "only" }),
        )
        .unwrap();
        assert_eq!(fallback.offered_models()[0].id, "only");
        let empty: EndpointConfig = serde_json::from_value(
            json!({ "name": "e", "kind": "scripted", "baseUrl": "x", "model": "only", "models": [] }),
        )
        .unwrap();
        assert!(empty.offered_models().is_empty());
        let blank: EndpointConfig = serde_json::from_value(
            json!({ "name": "e", "kind": "scripted", "baseUrl": "x", "models": [{ "id": "  " }, "a"] }),
        )
        .unwrap();
        assert_eq!(blank.offered_models().len(), 1);
    }

    #[test]
    fn the_catalogue_ladder_prefers_the_model_then_the_endpoint() {
        let endpoint = endpoint();
        assert_eq!(endpoint.base_url_for(None), "http://default/v1");
        assert_eq!(endpoint.base_url_for(Some("b")), "http://b/v1");
        assert_eq!(endpoint.context_window_for(Some("b")), Some(2000));
        assert_eq!(endpoint.context_window_for(None), Some(1000));
        assert_eq!(
            endpoint
                .reasoning_levels_for(Some("b"))
                .unwrap()
                .default
                .as_deref(),
            Some("low")
        );
        assert_eq!(
            endpoint.reasoning_levels_for(None).unwrap().levels[0].id,
            "off"
        );
        assert!(endpoint.reasoning_level_for(Some("b"), "low").is_some());
        assert!(endpoint.reasoning_level_for(None, "off").is_some());
        assert!(endpoint.reasoning_level_for(None, "high").is_none());
    }

    #[test]
    fn the_environment_names_an_endpoints_overrides() {
        let env = Env::default()
            .with("HEDDLE_PLUGBOARD_DS_BASE_URL", "http://gw/v1")
            .with("HEDDLE_PLUGBOARD_DS_MODEL", "m")
            .with("HEDDLE_PLUGBOARD_DS_API_KEY", "sk-x")
            .with("HEDDLE_PLUGBOARD_DS_API_KEY_FILE", "")
            .with("HEDDLE_PLUGBOARD_DS_KIND", "openai-responses");
        let patch = environment_override("plugboard-ds", &env);
        assert_eq!(patch.base_url.as_deref(), Some("http://gw/v1"));
        assert_eq!(patch.model.as_deref(), Some("m"));
        assert_eq!(patch.api_key.as_deref(), Some("sk-x"));
        assert_eq!(patch.kind, Some(EndpointKind::OpenaiResponses));
        assert_eq!(
            patch.api_key_file, None,
            "an empty variable is not an override"
        );
    }

    #[test]
    fn a_merge_overrides_only_the_fields_a_patch_names() {
        let base = default_endpoints().remove(0);
        let merged = merge_endpoint(
            &base,
            &[EndpointPatch {
                model: Some("other".into()),
                ..EndpointPatch::default()
            }],
        );
        assert_eq!(merged.model.as_deref(), Some("other"));
        assert_eq!(merged.base_url, "scripted.json");
        assert_eq!(merged.kind, EndpointKind::Scripted);
    }

    #[test]
    fn configured_endpoints_are_added_merged_with_the_environment_and_sorted() {
        let configured = vec![
            EndpointPatch {
                name: Some("my-gw".into()),
                kind: Some(EndpointKind::OpenaiChat),
                base_url: Some("http://gw/v1".into()),
                model: Some("written".into()),
                ..EndpointPatch::default()
            },
            EndpointPatch {
                name: Some("scripted".into()),
                model: Some("written".into()),
                ..EndpointPatch::default()
            },
        ];
        let env = Env::default().with("HEDDLE_SCRIPTED_MODEL", "from-env");
        let resolved = resolve_endpoints(&configured, &[], &env, &[]).unwrap();
        assert_eq!(
            resolved
                .iter()
                .map(|endpoint| endpoint.name.as_str())
                .collect::<Vec<_>>(),
            ["my-gw", "scripted"]
        );
        assert_eq!(
            resolved[0].model.as_deref(),
            Some("written"),
            "a brand-new endpoint is added as written"
        );
        assert_eq!(
            resolved[1].model.as_deref(),
            Some("from-env"),
            "an existing endpoint gets the environment override on top"
        );
    }

    #[test]
    fn a_new_endpoint_needs_a_kind_and_a_base_url() {
        let kindless = vec![EndpointPatch {
            name: Some("x".into()),
            base_url: Some("http://x/v1".into()),
            ..EndpointPatch::default()
        }];
        assert_eq!(
            resolve_endpoints(&kindless, &[], &Env::default(), &[])
                .unwrap_err()
                .problems(),
            ["endpoint 'x' needs a kind"]
        );
        let baseless = vec![EndpointPatch {
            name: Some("x".into()),
            kind: Some(EndpointKind::OpenaiChat),
            ..EndpointPatch::default()
        }];
        assert_eq!(
            resolve_endpoints(&baseless, &[], &Env::default(), &[])
                .unwrap_err()
                .problems(),
            ["endpoint 'x' needs a baseUrl"]
        );
        let nameless = vec![EndpointPatch::default()];
        assert_eq!(
            resolve_endpoints(&nameless, &[], &Env::default(), &[])
                .unwrap_err()
                .problems(),
            ["every endpoint needs a name"]
        );
    }

    #[test]
    fn exclude_is_applied_after_every_layer() {
        let local = vec![EndpointPatch {
            name: Some("mine".into()),
            kind: Some(EndpointKind::Scripted),
            base_url: Some("mine.json".into()),
            ..EndpointPatch::default()
        }];
        let resolved =
            resolve_endpoints(&[], &local, &Env::default(), &["scripted".to_string()]).unwrap();
        assert_eq!(
            resolved
                .iter()
                .map(|endpoint| endpoint.name.as_str())
                .collect::<Vec<_>>(),
            ["mine"]
        );
    }

    #[test]
    fn a_key_file_is_read_trimmed_and_never_echoed() {
        let root = scratch("key");
        let path = root.join("key");
        std::fs::write(&path, "  sk-secret\n").unwrap();
        let env = Env::default();
        let key = read_key_file(path.to_str().unwrap(), &env).unwrap();
        assert_eq!(key, "sk-secret");

        let endpoint = EndpointConfig {
            name: "e".into(),
            api_key_file: Some(path.to_string_lossy().into_owned()),
            ..EndpointConfig::default()
        };
        let materialized = materialize_key(endpoint, &env).unwrap();
        assert_eq!(materialized.api_key.as_deref(), Some("sk-secret"));

        std::fs::write(&path, "   \n").unwrap();
        let error = read_key_file(path.to_str().unwrap(), &env).unwrap_err();
        assert_eq!(
            error.problems(),
            [format!("the key file '{}' is empty", path.display())]
        );

        let missing = root.join("missing");
        let error = read_key_file(missing.to_str().unwrap(), &env).unwrap_err();
        assert!(error.problems()[0].starts_with("could not read the key file '"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_description_never_carries_a_secret() {
        let endpoint = EndpointConfig {
            name: "gateway".into(),
            kind: EndpointKind::OpenaiChat,
            base_url: "http://gw/v1".into(),
            model: Some("m".into()),
            api_key: Some("sk-secret".into()),
            api_key_file: Some("~/.keys/x".into()),
            headers: Some(BTreeMap::from([("X-Tenant".into(), "t".into())])),
            context_window: Some(1000),
            ..EndpointConfig::default()
        };
        let described = describe_endpoint(&endpoint);
        assert!(!described.to_string().contains("sk-secret"));
        assert_eq!(described["credential"], json!("set"));
        assert_eq!(described["credentialFile"], json!("~/.keys/x"));
        assert_eq!(described["headers"], json!(["X-Tenant"]));
        assert_eq!(described["contextWindowSource"], json!("config"));
        assert_eq!(described["models"][0]["name"], json!("m"));

        let view = describe_endpoints(&default_endpoints(), Some("nowhere"));
        assert_eq!(view.default, None);
        let view = describe_endpoints(&default_endpoints(), Some("scripted"));
        assert_eq!(view.default.as_deref(), Some("scripted"));
    }

    #[test]
    fn each_selection_problem_names_what_was_asked_and_declared() {
        let endpoint = endpoint();
        assert_eq!(
            selection_problem(&endpoint, Some("nowhere"), None),
            Some("no model named 'nowhere' on endpoint 'gateway'; configured: a, b".into())
        );
        assert_eq!(
            selection_problem(&endpoint, Some("b"), Some("high")),
            Some(
                "no reasoning effort named 'high' for model 'b' on endpoint 'gateway'; declared: low"
                    .into()
            )
        );
        assert_eq!(
            selection_problem(&endpoint, None, Some("nope")),
            Some(
                "no reasoning effort named 'nope' for model 'a' on endpoint 'gateway'; declared: off"
                    .into()
            )
        );
        assert_eq!(selection_problem(&endpoint, None, None), None);
        assert_eq!(selection_problem(&endpoint, Some("b"), Some("low")), None);

        let bare: EndpointConfig = serde_json::from_value(
            json!({ "name": "e", "kind": "scripted", "baseUrl": "x", "model": "m" }),
        )
        .unwrap();
        assert_eq!(
            selection_problem(&bare, None, Some("high")),
            Some("model 'm' on endpoint 'e' declares no reasoning effort levels".into())
        );
        assert_eq!(selection_problem(&bare, Some("m"), None), None);
    }

    #[test]
    fn the_defaults_are_offline_and_config_paths_follow_heddle_config() {
        let defaults = default_endpoints();
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].name, "scripted");
        assert_eq!(defaults[0].kind, EndpointKind::Scripted);
        assert_eq!(
            defaults[0].capabilities.as_ref().unwrap(),
            &vec!["offline".to_string(), "tools".to_string()]
        );

        let env = Env::default()
            .with("HOME", "/home/someone")
            .with("HEDDLE_CONFIG", "/etc/heddle.json");
        assert_eq!(config_paths(&env), [PathBuf::from("/etc/heddle.json")]);
        let env = Env::default()
            .with("HOME", "/home/someone")
            .with("HEDDLE_HOME", "/home/someone/.h");
        assert_eq!(
            config_paths(&env),
            [
                PathBuf::from("/home/someone/.h/heddle.json"),
                PathBuf::from("/home/someone/.heddle/heddle.json"),
            ]
        );
    }
}
