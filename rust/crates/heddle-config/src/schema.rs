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

    /// Every way `value` does not fit; empty when it fits. A mapping's properties are kept sorted, so
    /// their problems come in schema-key order rather than written order.
    ///
    /// A number where a number belongs fails with the TypeScript sentence above; every other problem
    /// names the expected and the found type, the missing key, or the refused key.
    pub fn check(&self, value: &Value) -> Vec<SchemaProblem> {
        let mut problems = Vec::new();
        self.check_into(value, "", &mut problems);
        problems
    }

    /// [`Schema::check`] below one field path, appending to `problems`.
    fn check_into(&self, value: &Value, path: &str, problems: &mut Vec<SchemaProblem>) {
        if let Some(kind) = &self.kind
            && !kind.matches(value)
        {
            problems.push(SchemaProblem {
                path: path.to_string(),
                message: type_message(kind, value),
            });
            // Every other keyword assumes the type the writer meant; checking them against the wrong
            // shape would add noise after the one sentence that explains the failure.
            return;
        }
        if let Some(allowed) = &self.allowed
            && !allowed.iter().any(|candidate| candidate == value)
        {
            problems.push(SchemaProblem {
                path: path.to_string(),
                message: "is not one of the allowed values".into(),
            });
        }
        if let Some(constant) = &self.constant
            && constant != value
        {
            problems.push(SchemaProblem {
                path: path.to_string(),
                message: format!("must be {constant}"),
            });
        }
        if !self.any_of.is_empty()
            && !self
                .any_of
                .iter()
                .any(|schema| schema.check(value).is_empty())
        {
            problems.push(SchemaProblem {
                path: path.to_string(),
                message: "does not match any allowed shape".into(),
            });
        }
        if let Value::Object(map) = value {
            for key in &self.required {
                if !map.contains_key(key) {
                    problems.push(SchemaProblem {
                        path: join(path, key),
                        message: "is required".into(),
                    });
                }
            }
            for (key, schema) in &self.properties {
                if let Some(child) = map.get(key) {
                    schema.check_into(child, &join(path, key), problems);
                }
            }
            match &self.additional_properties {
                Some(Additional::Allowed(false)) => {
                    for key in map.keys() {
                        if !self.properties.contains_key(key) {
                            problems.push(SchemaProblem {
                                path: join(path, key),
                                message: "is not an allowed field".into(),
                            });
                        }
                    }
                }
                Some(Additional::Schema(schema)) => {
                    for (key, child) in map {
                        if !self.properties.contains_key(key) {
                            schema.check_into(child, &join(path, key), problems);
                        }
                    }
                }
                _ => {}
            }
        }
        if let (Value::Array(items), Some(items_schema)) = (value, &self.items) {
            for (index, child) in items.iter().enumerate() {
                items_schema.check_into(child, &format!("{path}[{index}]"), problems);
            }
        }
    }
}

impl SchemaType {
    /// Does `value` have this JSON type? An integer is any number with no fractional part, as JSON
    /// Schema reads it, so `7.0` is an integer too.
    fn matches(self, value: &Value) -> bool {
        match self {
            SchemaType::Null => value.is_null(),
            SchemaType::Boolean => value.is_boolean(),
            SchemaType::Integer => {
                value.as_i64().is_some()
                    || value.as_u64().is_some()
                    || value
                        .as_f64()
                        .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
            }
            SchemaType::Number => value.is_number(),
            SchemaType::String => value.is_string(),
            SchemaType::Array => value.is_array(),
            SchemaType::Object => value.is_object(),
        }
    }

    /// The type as a sentence fragment: `a string`, `an integer`.
    fn article(self) -> &'static str {
        match self {
            SchemaType::Null => "null",
            SchemaType::Boolean => "a boolean",
            SchemaType::Integer => "an integer",
            SchemaType::Number => "a number",
            SchemaType::String => "a string",
            SchemaType::Array => "a sequence",
            SchemaType::Object => "a mapping",
        }
    }
}

impl TypeSet {
    /// Does `value` have one of the types this set names?
    fn matches(&self, value: &Value) -> bool {
        match self {
            TypeSet::One(kind) => kind.matches(value),
            TypeSet::Any(kinds) => kinds.iter().any(|kind| kind.matches(value)),
        }
    }

    /// Does this set expect a number of some kind? The number sentence is reserved for that case.
    fn expects_number(&self) -> bool {
        match self {
            TypeSet::One(kind) => matches!(kind, SchemaType::Integer | SchemaType::Number),
            TypeSet::Any(kinds) => kinds
                .iter()
                .any(|kind| matches!(kind, SchemaType::Integer | SchemaType::Number)),
        }
    }

    /// The types as a sentence fragment: `a string` or `one of a string, null`.
    fn describe(&self) -> String {
        match self {
            TypeSet::One(kind) => kind.article().to_string(),
            TypeSet::Any(kinds) => {
                let names: Vec<&str> = kinds.iter().map(|kind| kind.article()).collect();
                format!("one of {}", names.join(", "))
            }
        }
    }
}

/// The sentence for a wrong type. A non-number where a number belongs gets the TypeScript build's
/// sentence, because that is the failure its validator was written to surface.
fn type_message(kind: &TypeSet, value: &Value) -> String {
    if kind.expects_number() && !value.is_number() {
        return "is not a number, which means the value in the layer could not be read as one"
            .into();
    }
    format!("must be {}, not {}", kind.describe(), found_type(value))
}

/// What `value` is, as a sentence fragment.
fn found_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                "an integer"
            } else {
                "a number"
            }
        }
        Value::String(_) => "a string",
        Value::Array(_) => "a sequence",
        Value::Object(_) => "a mapping",
    }
}

/// A field path below `path`, or just `key` at the root.
fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
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

    fn schema(value: Value) -> Schema {
        Schema::from_json(value).unwrap()
    }

    #[test]
    fn a_string_where_a_number_belongs_reads_as_the_typescript_sentence() {
        let schema = schema(json!({
            "type": "object",
            "properties": { "count": { "type": "number" } }
        }));
        let problems = schema.check(&json!({ "count": "not-a-number" }));
        assert_eq!(
            problems,
            vec![SchemaProblem {
                path: "count".into(),
                message:
                    "is not a number, which means the value in the layer could not be read as one"
                        .into(),
            }]
        );
        assert_eq!(
            problems[0].to_string(),
            "count is not a number, which means the value in the layer could not be read as one"
        );
        assert!(schema.check(&json!({ "count": 7 })).is_empty());
    }

    #[test]
    fn required_keys_are_named_and_extra_keys_refused() {
        let schema = schema(json!({
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": { "type": "string" },
                "label": { "type": "string" }
            },
            "additionalProperties": false
        }));
        assert_eq!(
            schema
                .check(&json!({ "other": 1 }))
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["name is required", "other is not an allowed field"]
        );
        assert!(
            schema
                .check(&json!({ "name": "x", "label": "y" }))
                .is_empty()
        );
    }

    #[test]
    fn enum_const_and_any_of_are_checked() {
        let allowed = schema(json!({ "type": "string", "enum": ["a", "b"] }));
        assert_eq!(
            allowed.check(&json!("c"))[0].to_string(),
            "(root) is not one of the allowed values"
        );
        assert!(allowed.check(&json!("b")).is_empty());
        let constant = schema(json!({ "const": 7 }));
        assert_eq!(constant.check(&json!(8))[0].to_string(), "(root) must be 7");
        let any = schema(json!({ "anyOf": [{ "type": "string" }, { "type": "number" }] }));
        assert_eq!(
            any.check(&json!(true))[0].to_string(),
            "(root) does not match any allowed shape"
        );
    }

    #[test]
    fn nested_paths_and_sequence_indexes_are_named() {
        let schema = schema(json!({
            "type": "object",
            "properties": {
                "transport": { "type": "object", "properties": { "timeoutMs": { "type": "number" } } },
                "tags": { "type": "array", "items": { "type": "string" } }
            }
        }));
        let problems = schema.check(&json!({
            "transport": { "timeoutMs": "soon" },
            "tags": ["a", 2]
        }));
        assert_eq!(
            problems.iter().map(ToString::to_string).collect::<Vec<_>>(),
            vec![
                "tags[1] must be a string, not an integer",
                "transport.timeoutMs is not a number, which means the value in the layer could not be read as one",
            ]
        );
    }

    #[test]
    fn an_integer_accepts_a_whole_float_but_not_a_fraction() {
        let schema = schema(json!({ "type": "integer" }));
        assert!(schema.check(&json!(7)).is_empty());
        assert!(schema.check(&json!(7.0)).is_empty());
        assert_eq!(
            schema.check(&json!(7.5))[0].to_string(),
            "(root) must be an integer, not a number"
        );
    }

    #[test]
    fn additional_properties_may_be_checked_against_a_schema() {
        let schema = schema(json!({
            "type": "object",
            "properties": { "known": { "type": "string" } },
            "additionalProperties": { "type": "number" }
        }));
        assert!(
            schema
                .check(&json!({ "known": "x", "extra": 1 }))
                .is_empty()
        );
        assert_eq!(
            schema.check(&json!({ "extra": "no" }))[0].to_string(),
            "extra is not a number, which means the value in the layer could not be read as one"
        );
    }
}
