//! What a tool row's inspector shows, rendered on the server.
//!
//! Ported from `src/server/tool-inspector.ts`. DSH's inspector shows the payload and the schema parameters as
//! JSON and the result as a monospace block. The page only inserts markup it did not build, so every byte of a
//! model's strings is escaped here, and JSON is highlighted by the code renderer of `heddle-web-files`
//! (`renderCode(source, 'json', { gutter: false })`), reached through [`JsonHighlighter`].

use heddle_web_composer::ToolSchema;
use serde::{Deserialize, Serialize};

/// The code renderer, as the inspector needs it: `renderCode(source, "json", { gutter: false })`, which escapes
/// every byte and highlights it. Implemented over `heddle-web-files` by the host.
pub trait JsonHighlighter {
    fn render_json(&self, source: &str) -> String;
}

/// One tool row's inspector content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInspection {
    /// The arguments: highlighted JSON when they parse, `<pre class="tr-plain">` escaped text otherwise.
    pub payload: String,
    pub payload_is_json: bool,
    /// `<pre class="tr-result-text[ tr-error-text]">` escaped result.
    pub result: String,
    pub result_is_error: bool,
    /// The tool's definition, when the profile declares it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<SchemaInspection>,
}

/// The Schema section: name, description, and the parameters as highlighted JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaInspection {
    pub name: String,
    pub description: String,
    pub parameters: String,
}

/// A payload rendered for the inspector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPayload {
    pub html: String,
    pub is_json: bool,
}

/// One tool row, as the inspector reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ToolCall<'a> {
    pub payload: &'a str,
    pub result: &'a str,
    pub name: Option<&'a str>,
    pub error: bool,
}

/// JSON as re-indented, highlighted JSON when the trimmed text starts with `{` or `[` and parses; escaped text
/// otherwise — arguments are not always valid JSON.
pub fn render_payload(
    text: &str,
    highlighter: &(impl JsonHighlighter + ?Sized),
) -> RenderedPayload {
    let _ = (text, highlighter);
    todo!("render_payload")
}

/// One tool row's inspector content, with its schema looked up in the catalog by name.
pub fn inspect_tool(
    call: ToolCall<'_>,
    catalog: &[ToolSchema],
    highlighter: &(impl JsonHighlighter + ?Sized),
) -> ToolInspection {
    let _ = (call, catalog, highlighter);
    todo!("inspect_tool")
}
