//! The profile's tool catalog, as the Trajectory details pane shows it.
//!
//! Ported from `src/server/tool-catalog.ts`. DSH's tool inspector has a **Schema** section beside the payload and
//! the result: the tool's name, what it says it does, and the JSON Schema its arguments must satisfy. The tool
//! service already holds that; this module shapes it for the view, purely, so the shaping can be judged.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One tool as the tool service describes it (`ToolSpec` of `src/llm/types.ts`).
///
/// Declared here until `heddle-llm` publishes its `ToolSpec`; it will then become a re-export of that type, with
/// the same fields and the same serialised shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// The JSON Schema for the arguments; `None` when the tool declares none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
}

/// One tool's definition, as a view shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    /// The parameter JSON Schema; `{}` when the tool declares none, never absent.
    pub parameters: Value,
}

/// A stable, de-duplicated catalog: sorted by name, and the **first** definition of a name wins, because that is
/// the one the tool service registered and therefore the one the model was offered.
pub fn catalog_of(specs: &[ToolSpec]) -> Vec<ToolSchema> {
    let mut catalog: Vec<ToolSchema> = Vec::with_capacity(specs.len());
    for spec in specs {
        if catalog.iter().any(|tool| tool.name == spec.name) {
            continue;
        }
        catalog.push(ToolSchema {
            name: spec.name.clone(),
            description: spec.description.clone(),
            parameters: spec.parameters.clone().unwrap_or_else(|| json!({})),
        });
    }
    // The TypeScript sorts with `localeCompare`; tool names are lower-case ASCII identifiers, where that is the
    // same order as a byte comparison.
    catalog.sort_by(|left, right| left.name.cmp(&right.name));
    catalog
}

/// The definition of one tool, or `None` when the profile does not offer it.
pub fn schema_for<'a>(catalog: &'a [ToolSchema], name: &str) -> Option<&'a ToolSchema> {
    catalog.iter().find(|tool| tool.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, description: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            parameters: Some(json!({"type": "object"})),
        }
    }

    #[test]
    fn the_catalog_is_sorted_by_name() {
        let catalog = catalog_of(&[
            spec("write_file", "w"),
            spec("bash", "b"),
            spec("list_dir", "l"),
        ]);
        assert_eq!(
            catalog
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["bash", "list_dir", "write_file"]
        );
    }

    #[test]
    fn a_name_registered_twice_keeps_the_first_definition() {
        let catalog = catalog_of(&[spec("bash", "first"), spec("bash", "second")]);
        assert_eq!(catalog.len(), 1, "one name is one row");
        assert_eq!(
            schema_for(&catalog, "bash").map(|tool| tool.description.as_str()),
            Some("first")
        );
    }

    #[test]
    fn a_missing_parameter_schema_is_an_empty_object() {
        let catalog = catalog_of(&[ToolSpec {
            name: "bare".to_owned(),
            description: "no parameters".to_owned(),
            parameters: None,
        }]);
        assert_eq!(catalog[0].parameters, json!({}));
    }

    #[test]
    fn a_lookup_by_name_answers_the_definition_and_misses_cleanly() {
        let catalog = catalog_of(&[spec("bash", "b"), spec("list_dir", "l")]);
        assert_eq!(
            schema_for(&catalog, "list_dir").map(|tool| tool.name.as_str()),
            Some("list_dir")
        );
        assert!(schema_for(&catalog, "write_file").is_none());
    }
}
