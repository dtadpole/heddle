//! One endpoint's configuration and the model catalogue it offers.
//!
//! Ported from `EndpointConfig`, `ModelOption`, `ReasoningLevel(s)` and the lookups `offeredModels`, `modelOptionOf`,
//! `baseUrlFor`, `contextWindowFor`, `reasoningLevelsFor` and `reasoningLevelFor` in `src/llm/types.ts`. The lookups
//! are methods here; their TypeScript names are kept in the docs so a reader can grep for either.
//!
//! [`EndpointConfig`] deserializes from the configuration's JSON (`camelCase` keys) — the merged row the
//! configuration ladder produces (`src/endpoints.ts`, ported in `heddle-config`). It **never serializes its
//! `apiKey`**, and its `Debug` redacts it, so neither a log line nor an accidental `to_string` can leak a key.

use std::fmt;

use serde::de::{self, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Which wire shape an endpoint speaks.
///
/// A kind no adapter speaks is kept as [`EndpointKind::Other`] with the string the configuration gave, so a listing
/// can still show it; [`crate::adapter_for`] refuses it with `UNKNOWN_KIND`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EndpointKind {
    /// `openai-chat`: Chat Completions, `POST {baseUrl}/chat/completions`.
    OpenAiChat,
    /// `openai-responses`: Responses, `POST {baseUrl}/responses`, always streamed.
    OpenAiResponses,
    /// `anthropic-vertex`: Anthropic Messages on a cloud publisher route, `…:streamRawPredict`.
    AnthropicVertex,
    /// `scripted`: the offline fixture; `baseUrl` names a JSON script.
    Scripted,
    /// Anything else, as written.
    Other(String),
}

impl EndpointKind {
    /// The kind as the configuration spells it.
    pub fn as_str(&self) -> &str {
        match self {
            Self::OpenAiChat => "openai-chat",
            Self::OpenAiResponses => "openai-responses",
            Self::AnthropicVertex => "anthropic-vertex",
            Self::Scripted => "scripted",
            Self::Other(kind) => kind,
        }
    }

    /// The kind a configuration string names.
    pub fn parse(kind: &str) -> Self {
        match kind {
            "openai-chat" => Self::OpenAiChat,
            "openai-responses" => Self::OpenAiResponses,
            "anthropic-vertex" => Self::AnthropicVertex,
            "scripted" => Self::Scripted,
            other => Self::Other(other.to_owned()),
        }
    }

    /// Whether this wire publishes a model list (`GET {baseUrl}/models`): the two OpenAI shapes.
    pub fn has_model_list(&self) -> bool {
        matches!(self, Self::OpenAiChat | Self::OpenAiResponses)
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
        let kind = String::deserialize(deserializer)?;
        Ok(Self::parse(&kind))
    }
}

/// A reasoning level's wire value: the provider's own vocabulary (`low`, `high`) or a budget number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WireValue {
    Text(String),
    Number(serde_json::Number),
}

impl From<WireValue> for serde_json::Value {
    fn from(value: WireValue) -> Self {
        match value {
            WireValue::Text(text) => Self::String(text),
            WireValue::Number(number) => Self::Number(number),
        }
    }
}

/// One reasoning level: an id, a name, and the value the provider's wire expects.
///
/// `value: None` (JSON `null`) is a real, displayed level that sends no parameter — the provider's default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningLevel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub value: Option<WireValue>,
}

/// The levels a model offers, and the one it uses when nobody chose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningLevels {
    /// The level used when a session has recorded none. Absent means the provider's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    pub levels: Vec<ReasoningLevel>,
}

/// One model type an endpoint offers.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    /// The model id sent on the wire.
    pub id: String,
    /// The name a person reads; the id when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// This model's levels; replaces (never merges with) the endpoint's block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevels>,
    /// The gateway this model is served from, when it is not the endpoint's (a host per deployment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// This model's context window, when it differs from the endpoint's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// One entry of `models`: a bare id or a full option. `["a"]` and `[{"id":"a"}]` mean the same thing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelEntry {
    Id(String),
    Option(ModelOption),
}

impl ModelEntry {
    /// The model id this entry names.
    pub fn id(&self) -> &str {
        match self {
            Self::Id(id) => id,
            Self::Option(option) => &option.id,
        }
    }

    /// The entry as a full option.
    pub fn to_option(&self) -> ModelOption {
        match self {
            Self::Id(id) => ModelOption {
                id: id.clone(),
                ..ModelOption::default()
            },
            Self::Option(option) => option.clone(),
        }
    }
}

/// What a model accepts: the two input modalities the harness can deliver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputModality {
    Text,
    Image,
}

impl InputModality {
    /// The modality as the wire spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
        }
    }
}

/// Extra headers in declaration order, read from and written as a JSON object.
pub type Headers = Vec<(String, String)>;

/// One endpoint: a provider reached through one wire shape.
///
/// Field names are the configuration's (`camelCase`). Only `name`, `kind` and `baseUrl` are required for a row the
/// ladder accepts; the ladder (`heddle-config`) enforces that before a row reaches here.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointConfig {
    /// Stable name a request addresses this endpoint by.
    pub name: String,
    /// Which wire shape this endpoint speaks.
    pub kind: EndpointKind,
    /// Scheme, host and path prefix, without a trailing slash. For `scripted`, the script's path (`~` expanded).
    pub base_url: String,
    /// The endpoint's default model id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The model types this endpoint offers. Absent: the single `model`; neither: nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelEntry>>,
    /// Reasoning levels for every model that declares none of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevels>,
    /// The cloud project a publisher route is addressed under. Required by `anthropic-vertex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The region of that project's endpoint. Required by `anthropic-vertex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// Sent as a bearer token. Never serialized, never in `Debug`.
    #[serde(default, skip_serializing)]
    pub api_key: Option<String>,
    /// A path the ladder reads the key from (`materializeKey` in `heddle-config`); the model-list reader also
    /// reads it when no key was materialized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_file: Option<String>,
    /// Extra headers, for a gateway that gates on its own header.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "headers_serde::serialize",
        deserialize_with = "headers_serde::deserialize"
    )]
    pub headers: Option<Headers>,
    /// Force streaming on or off for this endpoint regardless of the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// Default cap on generated tokens for this endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// The model's context window, when the route knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// What this endpoint can do (`offline`, `tools`, `reasoning`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    /// What input the model accepts, as declared. Kept as strings so an unknown modality in a configuration is
    /// shown, not refused; only `image` changes behaviour ([`EndpointConfig::accepts_images`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    /// An HTTP forwarding proxy for this endpoint, as a URL (`http:` only, to an `http:` target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    /// Milliseconds of socket inactivity before a request is abandoned. Default 120 000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl fmt::Debug for EndpointConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EndpointConfig")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("models", &self.models)
            .field("reasoning", &self.reasoning)
            .field("project", &self.project)
            .field("region", &self.region)
            .field("api_key", &self.api_key.as_ref().map(|_| "<set>"))
            .field("api_key_file", &self.api_key_file)
            .field(
                "headers",
                &self
                    .headers
                    .as_ref()
                    .map(|h| h.iter().map(|(k, _)| k).collect::<Vec<_>>()),
            )
            .field("stream", &self.stream)
            .field("max_output_tokens", &self.max_output_tokens)
            .field("context_window", &self.context_window)
            .field("capabilities", &self.capabilities)
            .field("input_modalities", &self.input_modalities)
            .field("proxy", &self.proxy)
            .field("timeout_ms", &self.timeout_ms)
            .finish()
    }
}

impl EndpointConfig {
    /// A minimal endpoint: a name, a kind and an address; everything else absent.
    pub fn new(name: impl Into<String>, kind: EndpointKind, base_url: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind,
            base_url: base_url.into(),
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
        }
    }

    /// The model types this endpoint offers, in declaration order (`offeredModels`).
    ///
    /// String entries become options with only an id; entries with a blank id are dropped. No `models`: the single
    /// `model`, if any; neither: empty.
    pub fn offered_models(&self) -> Vec<ModelOption> {
        todo!("port offeredModels")
    }

    /// The catalogue entry a model id names, or `None` when the endpoint does not offer it (`modelOptionOf`).
    pub fn model_option(&self, model_id: Option<&str>) -> Option<ModelOption> {
        let _ = model_id;
        todo!("port modelOptionOf")
    }

    /// The address a request for this model is sent to: the model's own `baseUrl`, else the endpoint's
    /// (`baseUrlFor`). `None` means the endpoint's default model.
    pub fn base_url_for(&self, model_id: Option<&str>) -> String {
        let _ = model_id;
        todo!("port baseUrlFor")
    }

    /// The context window of the model a request would use: the model's own, else the endpoint's
    /// (`contextWindowFor`).
    pub fn context_window_for(&self, model_id: Option<&str>) -> Option<u64> {
        let _ = model_id;
        todo!("port contextWindowFor")
    }

    /// The levels a model offers: its own block, else the endpoint's, else none (`reasoningLevelsFor`).
    pub fn reasoning_levels_for(&self, model_id: Option<&str>) -> Option<ReasoningLevels> {
        let _ = model_id;
        todo!("port reasoningLevelsFor")
    }

    /// One declared level of one model, by id (`reasoningLevelFor`).
    pub fn reasoning_level_for(
        &self,
        model_id: Option<&str>,
        effort_id: &str,
    ) -> Option<ReasoningLevel> {
        let _ = (model_id, effort_id);
        todo!("port reasoningLevelFor")
    }

    /// Whether these models reason at all: the `reasoning` capability, an endpoint block, or any model's own block.
    /// It decides whether a Responses request asks for a reasoning summary.
    pub fn reasoning_configured(&self) -> bool {
        todo!("port reasoningConfigured from openAiResponsesAdapter")
    }

    /// Whether the declared modalities name `image` (`acceptsImages`). Absent means text only.
    pub fn accepts_images(&self) -> bool {
        todo!("port acceptsImages")
    }
}

/// `headers` as an ordered JSON object.
mod headers_serde {
    use super::*;

    pub fn serialize<S: Serializer>(
        headers: &Option<Headers>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match headers {
            None => serializer.serialize_none(),
            Some(pairs) => {
                let mut map = serializer.serialize_map(Some(pairs.len()))?;
                for (name, value) in pairs {
                    map.serialize_entry(name, value)?;
                }
                map.end()
            }
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Headers>, D::Error> {
        struct Pairs;
        impl<'de> Visitor<'de> for Pairs {
            type Value = Option<Headers>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of header names to string values")
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_some<D: Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<Self::Value, D::Error> {
                deserializer.deserialize_map(self)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut pairs = Vec::new();
                while let Some((name, value)) = access.next_entry::<String, String>()? {
                    pairs.push((name, value));
                }
                Ok(Some(pairs))
            }
        }
        deserializer.deserialize_option(Pairs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_configuration_row_deserializes_with_both_model_shapes_and_ordered_headers() {
        let row = r#"{
            "name": "gw", "kind": "openai-responses", "baseUrl": "http://127.0.0.1:1/v1",
            "model": "a", "models": ["a", {"id": "b", "name": "Bee", "baseUrl": "http://other", "contextWindow": 1000000,
              "reasoning": {"default": "low", "levels": [{"id": "low", "name": "Low", "value": "low"},
                                                         {"id": "def", "name": "Default", "value": null}]}}],
            "headers": {"x-z": "1", "x-a": "2"}, "apiKey": "secret", "timeoutMs": 5000
        }"#;
        let endpoint: EndpointConfig = serde_json::from_str(row).expect("parses");
        assert_eq!(endpoint.kind, EndpointKind::OpenAiResponses);
        let models = endpoint.models.as_ref().expect("models");
        assert_eq!(models[0], ModelEntry::Id("a".into()));
        assert_eq!(models[1].id(), "b");
        let ModelEntry::Option(bee) = &models[1] else {
            panic!("an option")
        };
        let levels = bee.reasoning.as_ref().expect("levels");
        assert_eq!(levels.levels[0].value, Some(WireValue::Text("low".into())));
        assert_eq!(levels.levels[1].value, None);
        assert_eq!(
            endpoint.headers,
            Some(vec![("x-z".into(), "1".into()), ("x-a".into(), "2".into())])
        );
        assert_eq!(endpoint.timeout_ms, Some(5000));
    }

    #[test]
    fn the_api_key_is_never_serialized_and_never_debug_printed() {
        let mut endpoint = EndpointConfig::new("chat", EndpointKind::OpenAiChat, "http://x");
        endpoint.api_key = Some("sk-very-secret".into());
        endpoint.headers = Some(vec![("x-token".into(), "header-secret".into())]);
        let json = serde_json::to_string(&endpoint).expect("serializes");
        assert!(!json.contains("sk-very-secret"), "{json}");
        assert!(!json.contains("apiKey"), "{json}");
        let debug = format!("{endpoint:?}");
        assert!(!debug.contains("sk-very-secret"), "{debug}");
        assert!(!debug.contains("header-secret"), "{debug}");
        assert!(debug.contains("<set>"));
    }

    #[test]
    fn an_unknown_kind_is_kept_as_written() {
        let endpoint: EndpointConfig =
            serde_json::from_str(r#"{"name":"x","kind":"carrier-pigeon","baseUrl":"coop"}"#)
                .expect("parses");
        assert_eq!(endpoint.kind, EndpointKind::Other("carrier-pigeon".into()));
        assert_eq!(endpoint.kind.to_string(), "carrier-pigeon");
        assert_eq!(
            serde_json::to_string(&endpoint).expect("serializes"),
            r#"{"name":"x","kind":"carrier-pigeon","baseUrl":"coop"}"#
        );
    }
}
