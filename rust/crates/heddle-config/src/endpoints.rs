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
use serde_json::{Number, Value};

use crate::env::Env;
use crate::error::ConfigError;

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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
        todo!("heddle-config: EndpointConfig::offered_models")
    }

    /// The catalogue entry `model_id` names (`modelOptionOf`); `None` for `None` or an unoffered id.
    pub fn model_option(&self, model_id: Option<&str>) -> Option<ModelOption> {
        let _ = model_id;
        todo!("heddle-config: EndpointConfig::model_option")
    }

    /// Where a request for `model_id` (the default model when `None`) is sent (`baseUrlFor`): the
    /// model's own `baseUrl`, else the endpoint's.
    pub fn base_url_for(&self, model_id: Option<&str>) -> String {
        let _ = model_id;
        todo!("heddle-config: EndpointConfig::base_url_for")
    }

    /// The context window of the model a request would use (`contextWindowFor`): the model's, else the
    /// endpoint's.
    pub fn context_window_for(&self, model_id: Option<&str>) -> Option<u64> {
        let _ = model_id;
        todo!("heddle-config: EndpointConfig::context_window_for")
    }

    /// The levels a model offers (`reasoningLevelsFor`): its own block, else the endpoint's, else none.
    /// `None` means the default model.
    pub fn reasoning_levels_for(&self, model_id: Option<&str>) -> Option<ReasoningLevels> {
        let _ = model_id;
        todo!("heddle-config: EndpointConfig::reasoning_levels_for")
    }

    /// One declared level of one model, by id (`reasoningLevelFor`).
    pub fn reasoning_level_for(
        &self,
        model_id: Option<&str>,
        effort_id: &str,
    ) -> Option<ReasoningLevel> {
        let _ = (model_id, effort_id);
        todo!("heddle-config: EndpointConfig::reasoning_level_for")
    }
}

/// The repository's own endpoints: only `scripted`, which is offline (`kind: scripted`,
/// `baseUrl: scripted.json`, `model: scripted`, `capabilities: [offline, tools]`). Nothing here points
/// at a paid service or carries a credential.
pub fn default_endpoints() -> Vec<EndpointConfig> {
    todo!("heddle-config: default_endpoints")
}

/// `configPaths` from `src/endpoints.ts`: `[$HEDDLE_CONFIG]` when it is non-empty, else
/// `[$HEDDLE_HOME/heddle.json, ~/.heddle/heddle.json]`. The TypeScript build defined it and called it
/// nowhere — [`crate::local_config_candidates`] is the rule a run uses — so it is ported for parity
/// only.
pub fn config_paths(env: &Env) -> Vec<PathBuf> {
    let _ = env;
    todo!("heddle-config: config_paths")
}

/// The environment's overrides for the endpoint `name`: `HEDDLE_<NAME>_BASE_URL`, `_MODEL`, `_API_KEY`,
/// `_API_KEY_FILE` and `_KIND`, where `<NAME>` is the name upper-cased with every character outside
/// `A-Z0-9` replaced by `_`. An empty variable is not an override.
pub fn environment_override(name: &str, env: &Env) -> EndpointPatch {
    let _ = (name, env);
    todo!("heddle-config: environment_override")
}

/// `base` with each patch applied in order, every present field overriding (`mergeEndpoint`).
pub fn merge_endpoint(base: &EndpointConfig, patches: &[EndpointPatch]) -> EndpointConfig {
    let _ = (base, patches);
    todo!("heddle-config: merge_endpoint")
}

/// The trimmed contents of a key file (`~` expanded), or an error naming the **setting's path, never
/// any part of the value**: `could not read the key file '{path}': {why}`, or
/// `the key file '{path}' is empty`.
pub fn read_key_file(path: &str, env: &Env) -> Result<String, ConfigError> {
    let _ = (path, env);
    todo!("heddle-config: read_key_file")
}

/// `endpoint` with `api_key_file` read into `api_key`, unless `api_key` is already set or no file is
/// named.
pub fn materialize_key(endpoint: EndpointConfig, env: &Env) -> Result<EndpointConfig, ConfigError> {
    let _ = (endpoint, env);
    todo!("heddle-config: materialize_key")
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
    let _ = (configured, local, env, exclude);
    todo!("heddle-config: resolve_endpoints")
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
    let _ = (endpoints, nominated);
    todo!("heddle-config: describe_endpoints")
}

/// A credential-free summary of an endpoint, safe to log or print: `name`, `kind`, `baseUrl`, `model`,
/// `models` (always present, each `{ id, name, reasoning?, contextWindow? }` with levels by id and name
/// only), `reasoning`, `project`, `region`, `proxy`, `capabilities`, `inputModalities`,
/// `contextWindow` with `contextWindowSource: "config"`, `credential: "set"` for a present key,
/// `credentialFile` for a key file's path, and `headers` as names only. Absent fields are left out.
pub fn describe_endpoint(endpoint: &EndpointConfig) -> Value {
    let _ = endpoint;
    todo!("heddle-config: describe_endpoint")
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
    let _ = (endpoint, model, effort);
    todo!("heddle-config: selection_problem")
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
}
