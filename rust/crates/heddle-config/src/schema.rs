//! The schema a component's configuration is checked against.
//!
//! The TypeScript build took each plugin's Schemastery schema from its module (`static Config` on a
//! class, or a `Config` export). A Rust component has no module to import, so its schema is **data**: a
//! subset of JSON Schema, which a built-in writes with `serde_json::json!` and an outside component
//! declares beside its command. JSON Schema rather than a new language, so nobody learns one for this.
//!
//! Supported keywords: `type` (one name or a list), `properties`, `required`, `additionalProperties`
//! (a boolean or a schema; absent allows anything, as Schemastery's object did), `items`, `enum`,
//! `const`, `anyOf`, `default` and `description`. Any other keyword is ignored rather than refused, so a
//! schema written for a richer validator still loads. Defaults are documentation here: a component
//! fills its own when it reads its configuration.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ConfigError;

/// A JSON type name, as `type` spells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaType {
    /// `null`.
    Null,
    /// `true` or `false`.
    Boolean,
    /// A number with no fractional part.
    Integer,
    /// Any number.
    Number,
    /// A string.
    String,
    /// A sequence.
    Array,
    /// A mapping.
    Object,
}

/// `type`: one name, or a list of which any may match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TypeSet {
    /// `type: number`.
    One(SchemaType),
    /// `type: [string, "null"]`.
    Any(Vec<SchemaType>),
}

/// `additionalProperties`: allowed or refused outright, or checked against a schema.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Additional {
    /// `true` allows any other key; `false` refuses every key `properties` does not name.
    Allowed(bool),
    /// Every other key's value is checked against this.
    Schema(Box<Schema>),
}

/// A configuration schema: the supported subset of JSON Schema.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    /// The types a value may have; absent allows any.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<TypeSet>,
    /// Schemas for the keys of a mapping.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, Schema>,
    /// Keys a mapping must hold.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<String>,
    /// What a key `properties` does not name may hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_properties: Option<Additional>,
    /// The schema of every element of a sequence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<Schema>>,
    /// The only values allowed.
    #[serde(rename = "enum", default, skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Vec<Value>>,
    /// The one value allowed.
    #[serde(rename = "const", default, skip_serializing_if = "Option::is_none")]
    pub constant: Option<Value>,
    /// Schemas of which at least one must accept the value.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub any_of: Vec<Schema>,
    /// The value a component uses when the key is absent; not applied by [`Schema::check`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// What the value is for, for a reader.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One way a value does not fit its schema.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaProblem {
    /// Where, as a field path below the component's `config` (`transport.timeoutMs`, `tags[2]`);
    /// empty for the value itself.
    pub path: String,
    /// What is wrong, as a sentence fragment that reads after the path.
    pub message: String,
}

impl fmt::Display for SchemaProblem {
    /// `{path} {message}`, or `(root) {message}` for the value itself — so a number that is not one
    /// reads `count is not a number, which means the value in the layer could not be read as one`, the
    /// TypeScript build's sentence.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = if self.path.is_empty() {
            "(root)"
        } else {
            &self.path
        };
        write!(f, "{path} {}", self.message)
    }
}

impl Schema {
    /// A schema from its JSON (or YAML-as-JSON) form; fails naming the keyword that cannot be read.
    pub fn from_json(value: Value) -> Result<Self, ConfigError> {
        serde_json::from_value(value)
            .map_err(|error| ConfigError::one(format!("not a configuration schema: {error}")))
    }

    /// Every way `value` does not fit, in document order; empty when it fits.
    ///
    /// A number where a number belongs fails with the TypeScript sentence above; every other problem
    /// names the expected and the found type, the missing key, or the refused key.
    pub fn check(&self, value: &Value) -> Vec<SchemaProblem> {
        let _ = value;
        todo!("heddle-config: Schema::check")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_json_schema_subset_loads_and_ignores_other_keywords() {
        let schema = Schema::from_json(json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "label": { "type": "string", "default": "none" },
                "count": { "type": "number", "default": 0 }
            },
            "additionalProperties": false
        }))
        .unwrap();
        assert_eq!(schema.kind, Some(TypeSet::One(SchemaType::Object)));
        assert_eq!(schema.properties.len(), 2);
        assert_eq!(
            schema.additional_properties,
            Some(Additional::Allowed(false))
        );
    }

    #[test]
    fn a_problem_reads_path_first() {
        let problem = SchemaProblem {
            path: "count".into(),
            message: "is not a number, which means the value in the layer could not be read as one"
                .into(),
        };
        assert_eq!(
            problem.to_string(),
            "count is not a number, which means the value in the layer could not be read as one"
        );
        let root = SchemaProblem {
            path: String::new(),
            message: "must be a mapping".into(),
        };
        assert_eq!(root.to_string(), "(root) must be a mapping");
    }

    #[test]
    fn an_unreadable_schema_fails_naming_why() {
        let error = Schema::from_json(json!({ "type": "no-such-type" })).unwrap_err();
        assert!(error.to_string().starts_with("not a configuration schema"));
    }
}
