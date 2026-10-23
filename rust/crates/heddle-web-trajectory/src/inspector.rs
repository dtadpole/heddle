//! What a tool row's inspector shows, rendered on the server.
//!
//! Ported from `src/server/tool-inspector.ts`. DSH's inspector shows the payload and the schema parameters as
//! JSON and the result as a monospace block. The page only inserts markup it did not build, so every byte of a
//! model's strings is escaped here, and JSON is highlighted by the code renderer of `heddle-web-files`
//! (`renderCode(source, 'json', { gutter: false })`), reached through [`JsonHighlighter`].

use heddle_web_composer::ToolSchema;
use heddle_web_composer::catalog::schema_for;
use heddle_web_composer::js;
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
    let trimmed = js::trim(text);
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed)
    {
        return RenderedPayload {
            html: highlighter.render_json(&js::stringify_pretty(&parsed)),
            is_json: true,
        };
    }
    RenderedPayload {
        html: format!("<pre class=\"tr-plain\">{}</pre>", js::escape_html(text)),
        is_json: false,
    }
}

/// One tool row's inspector content, with its schema looked up in the catalog by name.
pub fn inspect_tool(
    call: ToolCall<'_>,
    catalog: &[ToolSchema],
    highlighter: &(impl JsonHighlighter + ?Sized),
) -> ToolInspection {
    let payload = render_payload(call.payload, highlighter);
    let class = if call.error {
        "tr-result-text tr-error-text"
    } else {
        "tr-result-text"
    };
    let result = format!(
        "<pre class=\"{class}\">{}</pre>",
        js::escape_html(call.result)
    );
    let schema = call
        .name
        .and_then(|name| schema_for(catalog, name))
        .map(|tool| SchemaInspection {
            name: tool.name.clone(),
            description: tool.description.clone(),
            parameters: highlighter.render_json(&js::stringify_pretty(&tool.parameters)),
        });
    ToolInspection {
        payload: payload.html,
        payload_is_json: payload.is_json,
        result,
        result_is_error: call.error,
        schema,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use heddle_web_composer::catalog::catalog_of;

    /// A stand-in for `heddle-web-files`: escapes, highlights nothing, and says so with a class.
    struct EscapeHighlighter;

    impl JsonHighlighter for EscapeHighlighter {
        fn render_json(&self, source: &str) -> String {
            format!(
                "<code class=\"hljs-json\">{}</code>",
                js::escape_html(source)
            )
        }
    }

    fn reference_highlighter() -> EscapeHighlighter {
        EscapeHighlighter
    }

    #[test]
    fn valid_json_arguments_are_rendered_as_highlighted_json_without_a_line_gutter() {
        let rendered = render_payload(
            "{\"path\": \"/tmp\", \"limit\": 10}",
            &reference_highlighter(),
        );
        assert!(rendered.is_json, "the arguments parse");
        assert!(
            rendered.html.contains("hljs-"),
            "the renderer highlights them"
        );
        assert!(
            !rendered.html.contains("class=\"ln\""),
            "an inspector block needs no line numbers"
        );
        assert!(
            rendered.html.contains("&quot;path&quot;"),
            "and the keys are still escaped text"
        );
        assert!(rendered.html.contains("\n  "), "re-indented as JSON");
    }

    #[test]
    fn numbers_in_the_arguments_read_as_javascript_prints_them() {
        // `JSON.stringify(JSON.parse(text), null, 2)` in the TypeScript inspector: a model's `1.0` shows as `1`,
        // `1e3` as `1000` — measured differing against the TypeScript build before this module existed.
        let rendered = render_payload(
            "{\"timeout\": 1.0, \"n\": 1e3, \"half\": 0.5}",
            &reference_highlighter(),
        );
        assert!(rendered.is_json);
        assert!(
            rendered.html.contains("&quot;timeout&quot;: 1,"),
            "1.0 reads as 1: {}",
            rendered.html
        );
        assert!(
            rendered.html.contains("&quot;n&quot;: 1000,"),
            "1e3 reads as 1000"
        );
        assert!(rendered.html.contains("&quot;half&quot;: 0.5"));
        assert!(
            !rendered.html.contains("1.0"),
            "no Rust-style trailing fraction survives"
        );
    }

    #[test]
    fn arguments_that_are_not_json_are_shown_as_escaped_text() {
        let rendered = render_payload(
            "{\"path\": <script>alert(1)</script>",
            &reference_highlighter(),
        );
        assert!(!rendered.is_json);
        assert!(
            !rendered.html.contains("<script"),
            "a payload cannot become markup"
        );
        assert!(
            rendered.html.contains("&lt;script&gt;"),
            "and it is visible as text"
        );
        assert!(rendered.html.contains("tr-plain"));
    }

    #[test]
    fn text_that_does_not_begin_with_a_brace_or_bracket_is_text() {
        let rendered = render_payload("[not json", &reference_highlighter());
        assert!(!rendered.is_json, "a partial array is not JSON either");
        assert!(rendered.html.contains("&lt;") || rendered.html.contains("[not json"));
    }

    #[test]
    fn an_error_result_is_marked_so_the_pane_can_tint_it() {
        let inspection = inspect_tool(
            ToolCall {
                payload: "{}",
                result: "error: exit 1",
                name: None,
                error: true,
            },
            &[],
            &reference_highlighter(),
        );
        assert!(inspection.result_is_error);
        assert!(inspection.result.contains("tr-error-text"));
        assert!(inspection.result.contains("error: exit 1"));
        assert!(
            inspection
                .result
                .starts_with("<pre class=\"tr-result-text tr-error-text\">")
        );
    }

    #[test]
    fn an_ok_result_has_no_error_class_and_is_escaped() {
        let inspection = inspect_tool(
            ToolCall {
                payload: "{}",
                result: "a < b",
                name: None,
                error: false,
            },
            &[],
            &reference_highlighter(),
        );
        assert!(!inspection.result_is_error);
        assert!(!inspection.result.contains("tr-error-text"));
        assert!(inspection.result.contains("a &lt; b"));
    }

    #[test]
    fn a_tool_the_profile_declares_carries_its_schema_and_an_unknown_one_does_not() {
        let catalog = catalog_of(&[heddle_web_composer::ToolSpec {
            name: "bash".to_owned(),
            description: "run a shell".to_owned(),
            parameters: Some(
                json!({"type": "object", "properties": {"command": {"type": "string"}}}),
            ),
        }]);
        let known = inspect_tool(
            ToolCall {
                payload: "{\"command\":\"pwd\"}",
                result: "ok",
                name: Some("bash"),
                error: false,
            },
            &catalog,
            &reference_highlighter(),
        );
        let schema = known.schema.expect("the tool's definition");
        assert_eq!(schema.name, "bash");
        assert_eq!(schema.description, "run a shell");
        assert!(schema.parameters.contains("hljs-"));
        assert!(schema.parameters.contains("command"));
        assert!(schema.parameters.contains("&quot;type&quot;"));
        let unknown = inspect_tool(
            ToolCall {
                payload: "{}",
                result: "ok",
                name: Some("nope"),
                error: false,
            },
            &catalog,
            &reference_highlighter(),
        );
        assert!(unknown.schema.is_none());
    }
}
