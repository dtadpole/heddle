//! Tool-argument validation, DSH's (R-developer-five-6, coordinator ruling (a)).
//!
//! A call's arguments are checked against the tool's declared parameter schema before it runs; a violation is an
//! `INVALID_ARGS` result (`invalid arguments: <violations>`). Ported from `dsh-tools`' `validateJsonSchemaValue`
//! sentence for sentence, as `src/tools/validate.ts` is: the root is named `arguments`, a property path is `key`
//! at the root and `parent.key` below it, an array item `path[index]`; an object reports missing required
//! properties, then each present declared property in declaration order, then — only where the schema says
//! `additionalProperties: false` — each undeclared key. Unknown top-level keys pass: DSH's tool roots are open.

use serde_json::Value;

fn named(path: &str) -> &str {
    if path.is_empty() { "arguments" } else { path }
}

fn below(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

fn scalar(schema: &serde_json::Map<String, Value>, value: &Value, path: &str) -> Vec<String> {
    if let Some(Value::Array(allowed)) = schema.get("enum")
        && !allowed.contains(value)
    {
        let list = serde_json::to_string(allowed).unwrap_or_default();
        return vec![format!("\"{}\" must be one of {list}", named(path))];
    }
    if let Some(constant) = schema.get("const")
        && constant != value
    {
        let shown = serde_json::to_string(constant).unwrap_or_default();
        return vec![format!("\"{}\" must be {shown}", named(path))];
    }
    Vec::new()
}

/// Every way `value` breaks `schema`, in DSH's order; empty when it is valid.
pub fn argument_violations(schema: &Value, value: &Value, path: &str) -> Vec<String> {
    let Some(schema) = schema.as_object() else {
        return Vec::new();
    };
    if let Some(Value::Array(branches)) = schema.get("oneOf") {
        let matches = branches
            .iter()
            .filter(|branch| argument_violations(branch, value, path).is_empty())
            .count();
        return if matches == 1 {
            Vec::new()
        } else {
            vec![format!(
                "\"{}\" must match exactly one oneOf branch (matched {matches})",
                named(path)
            )]
        };
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let Some(record) = value.as_object() else {
                return vec![format!("\"{}\" must be an object", named(path))];
            };
            let empty = serde_json::Map::new();
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let mut violations = Vec::new();
            if let Some(Value::Array(required)) = schema.get("required") {
                for key in required.iter().filter_map(Value::as_str) {
                    if !record.contains_key(key) {
                        violations.push(format!(
                            "missing required property \"{}\"",
                            below(path, key)
                        ));
                    }
                }
            }
            for (key, node) in properties {
                if let Some(present) = record.get(key) {
                    violations.extend(argument_violations(node, present, &below(path, key)));
                }
            }
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                for key in record.keys() {
                    if !properties.contains_key(key) {
                        violations.push(format!(
                            "\"{}\" is not a declared property (additionalProperties: false)",
                            below(path, key)
                        ));
                    }
                }
            }
            violations
        }
        Some("array") => {
            let Some(entries) = value.as_array() else {
                return vec![format!("\"{}\" must be an array", named(path))];
            };
            let Some(items) = schema.get("items") else {
                return Vec::new();
            };
            entries
                .iter()
                .enumerate()
                .flat_map(|(index, entry)| {
                    argument_violations(items, entry, &format!("{path}[{index}]"))
                })
                .collect()
        }
        Some("string") => match value {
            Value::String(_) => scalar(schema, value, path),
            _ => vec![format!("\"{}\" must be a string", named(path))],
        },
        Some("number") => match value {
            Value::Number(_) => scalar(schema, value, path),
            _ => vec![format!("\"{}\" must be a number", named(path))],
        },
        Some("integer") => match value {
            Value::Number(number)
                if number.is_i64()
                    || number.is_u64()
                    || number.as_f64().is_some_and(|f| f.fract() == 0.0) =>
            {
                scalar(schema, value, path)
            }
            _ => vec![format!("\"{}\" must be an integer", named(path))],
        },
        Some("boolean") => match value {
            Value::Bool(_) => scalar(schema, value, path),
            _ => vec![format!("\"{}\" must be a boolean", named(path))],
        },
        Some("null") => match value {
            Value::Null => scalar(schema, value, path),
            _ => vec![format!("\"{}\" must be null", named(path))],
        },
        _ => Vec::new(),
    }
}

/// The refusal's sentence, DSH's `ToolArgsError` message.
pub fn invalid_arguments(violations: &[String]) -> String {
    format!("invalid arguments: {}", violations.join("; "))
}

/// A tool's parameter schema as DSH shapes a root: open (`openRoot` in the TypeScript build).
///
/// `defineTool` compiles a root with no `additionalProperties`, so an unknown top-level key is accepted; a nested
/// node keeps what it declares. Applied where a schema leaves the registry and where a call is validated, so a
/// tool's own spec never has to change. The map is rebuilt rather than `remove`d from, because with
/// `preserve_order` a removal swaps the last key into place and the wire's key order would change.
pub fn open_root(parameters: &Value) -> Value {
    match parameters {
        Value::Object(map) if map.contains_key("additionalProperties") => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "additionalProperties")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash() -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" },
                "description": { "type": "string" },
                "timeoutMs": { "type": "integer" },
                "sandbox_permissions": { "type": "string", "enum": ["use_default", "require_escalated"] },
                "opts": { "type": "object", "additionalProperties": false, "properties": { "a": { "type": "array", "items": { "type": "number" } } } }
            },
            "required": ["command", "description"]
        })
    }

    #[test]
    fn a_missing_required_property_is_refused_in_dsh_s_words() {
        let violations = argument_violations(&bash(), &json!({ "command": "ls" }), "");
        assert_eq!(
            invalid_arguments(&violations),
            "invalid arguments: missing required property \"description\""
        );
    }

    #[test]
    fn an_unknown_top_level_key_passes_because_the_root_is_open() {
        let args = json!({ "command": "ls", "description": "d", "run_in_background": true });
        assert!(argument_violations(&bash(), &args, "").is_empty());
    }

    #[test]
    fn wrong_types_and_a_bad_enum_are_named_by_path_in_declaration_order() {
        let args = json!({ "command": 1, "description": "d", "timeoutMs": 1.5, "sandbox_permissions": "x" });
        assert_eq!(
            argument_violations(&bash(), &args, ""),
            vec![
                "\"command\" must be a string",
                "\"timeoutMs\" must be an integer",
                "\"sandbox_permissions\" must be one of [\"use_default\",\"require_escalated\"]",
            ]
        );
    }

    #[test]
    fn a_nested_closed_node_refuses_undeclared_keys_after_its_items() {
        let args =
            json!({ "command": "ls", "description": "d", "opts": { "a": [1, "two"], "b": 1 } });
        assert_eq!(
            argument_violations(&bash(), &args, ""),
            vec![
                "\"opts.a[1]\" must be a number",
                "\"opts.b\" is not a declared property (additionalProperties: false)",
            ]
        );
    }

    #[test]
    fn arguments_that_are_not_an_object_and_one_of_are_worded_as_dsh_words_them() {
        assert_eq!(
            argument_violations(&bash(), &json!("nope"), ""),
            vec!["\"arguments\" must be an object"]
        );
        let either = json!({ "oneOf": [{ "type": "string" }, { "type": "number" }] });
        assert!(argument_violations(&either, &json!("x"), "v").is_empty());
        assert_eq!(
            argument_violations(&either, &json!(true), "v"),
            vec!["\"v\" must match exactly one oneOf branch (matched 0)"]
        );
    }

    #[test]
    fn open_root_drops_only_the_root_s_additional_properties_and_keeps_key_order() {
        let closed = json!({ "type": "object", "properties": { "o": { "type": "object", "additionalProperties": false } }, "additionalProperties": false, "required": [] });
        let open = open_root(&closed);
        assert_eq!(
            open,
            json!({ "type": "object", "properties": { "o": { "type": "object", "additionalProperties": false } }, "required": [] })
        );
        let keys: Vec<&String> = open.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["type", "properties", "required"],
            "the remaining keys keep their order"
        );
    }
}
