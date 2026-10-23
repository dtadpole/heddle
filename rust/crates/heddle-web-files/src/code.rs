//! The renderer decision and the code renderer — the port of `src/server/code.ts`.
//!
//! One rule: **this crate writes every tag, and every byte of the file is escaped.** A file containing
//! `<script>alert(1)</script>` arrives in the panel as visible text, never as a script (claim of
//! `_verifiers_/80-web-ui` check-file-view). The line gutter is presentation, so it sits in its own
//! `<span class="ln">` that the page makes unselectable, and a copy of the panel gets the source without numbers.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// What the File panel should do with a file. Serialized lower-case, as the page reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererName {
    /// A document: rendered by [`crate::markdown`].
    Markdown,
    /// A page: no markup here; the page fetches `GET /api/html` and shows it in a sandboxed frame.
    Html,
    /// Source: highlighted by [`render_code`], with a gutter.
    Code,
    /// Anything else: shown verbatim by the page, with no markup produced for it.
    Text,
}

/// The decision about one file, made from its path alone, before its text is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RendererDecision {
    pub renderer: RendererName,
    /// The language name, present exactly when `renderer` is [`RendererName::Code`].
    pub language: Option<&'static str>,
}

/// The decision and its markup: the part of the `GET /api/file` answer this crate adds to the file reading.
///
/// Serialized as `{"renderer": …, "language"?: …, "html"?: …}`: `language` only for code, `html` for markdown and
/// code. Absent fields are **absent**, not `null` — the verifiers assert `html === undefined` for text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rendered {
    pub renderer: RendererName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
}

/// The languages the code renderer knows, by lower-cased extension. Same table as `code.ts`: the name is what
/// `GET /api/file` reports as `language`, and what [`crate::highlight`] is asked for.
pub(crate) const LANGUAGES: &[(&str, &str)] = &[
    (".js", "javascript"),
    (".mjs", "javascript"),
    (".cjs", "javascript"),
    (".jsx", "javascript"),
    (".ts", "typescript"),
    (".mts", "typescript"),
    (".cts", "typescript"),
    (".tsx", "typescript"),
    (".py", "python"),
    (".pyi", "python"),
    (".json", "json"),
    (".sh", "shell"),
    (".bash", "shell"),
    (".zsh", "shell"),
    (".yml", "yaml"),
    (".yaml", "yaml"),
    (".toml", "ini"),
    (".ini", "ini"),
    (".cfg", "ini"),
    (".mdx", "markdown"),
    (".sql", "sql"),
    (".rb", "ruby"),
    (".rs", "rust"),
    (".go", "go"),
    (".java", "java"),
    (".c", "c"),
    (".h", "c"),
    (".cpp", "cpp"),
    (".hpp", "cpp"),
    (".cc", "cpp"),
    (".css", "css"),
    (".svg", "xml"),
    (".xml", "xml"),
    (".diff", "diff"),
    (".patch", "diff"),
];

/// The language a path's extension names, or `None` when the code renderer does not know it.
pub fn language_for(path: &Path) -> Option<&'static str> {
    let extension = crate::node_path::extname(&path.to_string_lossy()).to_lowercase();
    LANGUAGES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, language)| *language)
}

/// What should be done with a file, from its extension: `.md`/`.markdown` → markdown, `.html`/`.htm` → html, a
/// known source extension → code with its language, anything else → text.
pub fn renderer_for(path: &Path) -> RendererDecision {
    let extension = crate::node_path::extname(&path.to_string_lossy()).to_lowercase();
    match extension.as_str() {
        ".md" | ".markdown" => RendererDecision {
            renderer: RendererName::Markdown,
            language: None,
        },
        ".html" | ".htm" => RendererDecision {
            renderer: RendererName::Html,
            language: None,
        },
        _ => match language_for(path) {
            Some(language) => RendererDecision {
                renderer: RendererName::Code,
                language: Some(language),
            },
            None => RendererDecision {
                renderer: RendererName::Text,
                language: None,
            },
        },
    }
}

/// Options for [`render_code`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeOptions {
    /// Number the lines in a `<span class="ln">` gutter. On by default; the tool inspector turns it off.
    pub gutter: bool,
}

impl Default for CodeOptions {
    fn default() -> Self {
        Self { gutter: true }
    }
}

/// Render source as line-numbered, escaped, highlighted markup.
///
/// `\r\n` and `\r` become `\n`. The result is `<code class="code">`, then one
/// `<span class="line"><span class="ln">N</span>…</span>` per line (the `\n` kept inside the line it ends, so a
/// file of `k` newlines has `k + 1` rows), then `</code>`. Classified text is
/// `<span class="hljs-…">escaped</span>`; everything else is escaped text. Without the gutter a row is
/// `<span class="line">…</span>`.
pub fn render_code(source: &str, language: &str, options: CodeOptions) -> String {
    todo!("port renderCode from src/server/code.ts over highlight::highlight_pieces")
}

/// Decide how to show one file's text, and produce the markup when there is any.
///
/// Markdown is wrapped as `<div class="markdown">…</div>` and rendered with the file's folder as its base; code is
/// [`render_code`] with the gutter; html and text carry no markup.
pub fn render_source(path: &Path, text: &str) -> Rendered {
    todo!("port renderSource from src/server/code.ts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_decision_follows_the_extension_case_insensitively() {
        let decide = |path: &str| renderer_for(Path::new(path));
        assert_eq!(
            decide("/w/AGENTS.md"),
            RendererDecision {
                renderer: RendererName::Markdown,
                language: None
            }
        );
        assert_eq!(decide("/w/notes.MARKDOWN").renderer, RendererName::Markdown);
        assert_eq!(decide("/w/page.HTM").renderer, RendererName::Html);
        assert_eq!(
            decide("/w/package.json"),
            RendererDecision {
                renderer: RendererName::Code,
                language: Some("json")
            }
        );
        assert_eq!(
            decide("/w/cordis.yml").language,
            Some("yaml"),
            "yaml is code, measured as text before the map covered it"
        );
        assert_eq!(decide("/w/Cargo.toml").language, Some("ini"));
        assert_eq!(decide("/w/run.sh").language, Some("shell"));
        assert_eq!(decide("/w/icon.svg").language, Some("xml"));
        assert_eq!(
            decide("/w/doc.mdx").language,
            Some("markdown"),
            ".mdx is highlighted source, not a rendered document"
        );
    }

    #[test]
    fn a_file_with_no_known_extension_is_text() {
        let decide = |path: &str| renderer_for(Path::new(path));
        assert_eq!(
            decide("/w/LICENSE"),
            RendererDecision {
                renderer: RendererName::Text,
                language: None
            }
        );
        assert_eq!(decide("/w/notes.txt").renderer, RendererName::Text);
        assert_eq!(
            decide("/w/.bashrc").renderer,
            RendererName::Text,
            "a leading dot is not an extension"
        );
        assert_eq!(decide("/w/page.html").language, None);
    }

    #[test]
    fn rendered_omits_absent_fields_rather_than_writing_null() {
        let text = Rendered {
            renderer: RendererName::Text,
            language: None,
            html: None,
        };
        assert_eq!(
            serde_json::to_string(&text).unwrap(),
            r#"{"renderer":"text"}"#
        );
        let code = Rendered {
            renderer: RendererName::Code,
            language: Some("json".into()),
            html: Some("<code>".into()),
        };
        assert_eq!(
            serde_json::to_string(&code).unwrap(),
            r#"{"renderer":"code","language":"json","html":"<code>"}"#
        );
        let html = Rendered {
            renderer: RendererName::Html,
            language: None,
            html: None,
        };
        assert_eq!(
            serde_json::to_string(&html).unwrap(),
            r#"{"renderer":"html"}"#
        );
    }
}
