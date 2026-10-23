//! The profile's tool catalog, as the Trajectory details pane shows it.
//!
//! Ported from `src/server/tool-catalog.ts`. DSH's tool inspector has a **Schema** section beside the payload and
//! the result: the tool's name, what it says it does, and the JSON Schema its arguments must satisfy. The tool
//! service already holds that; this module shapes it for the view, purely, so the shaping can be judged.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    let _ = specs;
    todo!("catalog_of")
}

/// The definition of one tool, or `None` when the profile does not offer it.
pub fn schema_for<'a>(catalog: &'a [ToolSchema], name: &str) -> Option<&'a ToolSchema> {
    let _ = (catalog, name);
    todo!("schema_for")
}
