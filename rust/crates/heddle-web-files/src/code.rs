//! The renderer decision and the code renderer — the port of `src/server/code.ts`.
//!
//! One rule: **this crate writes every tag, and every byte of the file is escaped.** A file containing
//! `<script>alert(1)</script>` arrives in the panel as visible text, never as a script (claim of
//! `_verifiers_/80-web-ui` check-file-view). The line gutter is presentation, so it sits in its own
//! `<span class="ln">` that the page makes unselectable, and a copy of the panel gets the source without numbers.

use std::path::Path;

use serde::Serialize;

/// What the File panel should do with a file. Serialized lower-case, as the page reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rendered {
    pub renderer: RendererName,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    let text = source.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(text.len() + 48);
    out.push_str("<code class=\"code\">");
    let mut line = 1usize;
    let mut open = false;
    let start_line = |out: &mut String, line: usize, open: &mut bool| {
        if options.gutter {
            out.push_str("<span class=\"line\"><span class=\"ln\">");
            out.push_str(&line.to_string());
            out.push_str("</span>");
        } else {
            out.push_str("<span class=\"line\">");
        }
        *open = true;
    };
    start_line(&mut out, line, &mut open);
    for piece in crate::highlight::highlight_pieces(&text, Some(language)) {
        if piece.newline {
            out.push('\n');
            if open {
                out.push_str("</span>");
            }
            line += 1;
            start_line(&mut out, line, &mut open);
            continue;
        }
        match piece.class {
            Some(class) => {
                out.push_str("<span class=\"");
                out.push_str(class);
                out.push_str("\">");
                out.push_str(&crate::markdown::escape_html(&piece.text));
                out.push_str("</span>");
            }
            None => out.push_str(&crate::markdown::escape_html(&piece.text)),
        }
    }
    if open {
        out.push_str("</span>");
    }
    out.push_str("</code>");
    out
}

/// Decide how to show one file's text, and produce the markup when there is any.
///
/// Markdown is wrapped as `<div class="markdown">…</div>` and rendered with the file's folder as its base; code is
/// [`render_code`] with the gutter; html and text carry no markup.
pub fn render_source(path: &Path, text: &str) -> Rendered {
    let decision = renderer_for(path);
    match decision.renderer {
        RendererName::Markdown => {
            let base = path.parent();
            Rendered {
                renderer: RendererName::Markdown,
                language: None,
                html: Some(format!(
                    "<div class=\"markdown\">{}</div>",
                    crate::markdown::render_markdown(
                        text,
                        crate::markdown::MarkdownOptions { base }
                    )
                )),
            }
        }
        RendererName::Code => {
            let Some(language) = decision.language else {
                return Rendered {
                    renderer: RendererName::Text,
                    language: None,
                    html: None,
                };
            };
            Rendered {
                renderer: RendererName::Code,
                language: Some(language.to_string()),
                html: Some(render_code(text, language, CodeOptions::default())),
            }
        }
        // A page has no markup here: the panel fetches `GET /api/html` and shows it in a sandboxed frame.
        RendererName::Html | RendererName::Text => Rendered {
            renderer: decision.renderer,
            language: None,
            html: None,
        },
    }
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

    /// The rows of a rendered block, split at the line wrapper, with the gutter number in front of each.
    fn rows(html: &str) -> Vec<String> {
        html.split("<span class=\"line\">")
            .skip(1)
            .map(|row| {
                row.split("</span></span>")
                    .next()
                    .unwrap_or(row)
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn a_file_of_k_newlines_has_k_plus_one_numbered_rows() {
        for (source, expected) in [("", 1), ("a", 1), ("a\n", 2), ("a\nb\nc", 3), ("\n", 2)] {
            let html = render_code(source, "text_stub", CodeOptions::default());
            assert_eq!(
                rows(&html).len(),
                expected,
                "{source:?} should have {expected} rows: {html}"
            );
        }
        // An unknown language is still code, escaped and unclassified, rather than an error.
        let html = render_code("a\nb", "not-a-language", CodeOptions::default());
        assert!(html.starts_with("<code class=\"code\">"));
        assert!(html.ends_with("</code>"));
        assert_eq!(rows(&html).len(), 2);
    }

    #[test]
    fn the_gutter_starts_at_one_and_numbers_every_row() {
        let html = render_code("a\nb\nc", "text_stub", CodeOptions::default());
        let gutter: Vec<&str> = html
            .split("<span class=\"ln\">")
            .skip(1)
            .filter_map(|rest| rest.split('<').next())
            .collect();
        assert_eq!(gutter, ["1", "2", "3"]);
    }

    #[test]
    fn a_script_in_a_file_arrives_as_text() {
        // The claim of `_verifiers_/80-web-ui` check-file-view: the bytes are escaped, never written as markup.
        let html = render_code(
            "<script>alert(1)</script>",
            "not-a-language",
            CodeOptions::default(),
        );
        assert!(!html.contains("<script>"), "no tag survives: {html}");
        assert!(
            html.contains("&lt;script&gt;"),
            "and the text is readable: {html}"
        );
        assert!(html.contains("alert(1)"));
    }

    #[test]
    fn a_block_comment_spanning_lines_keeps_its_class_on_both_rows() {
        let html = render_code("/* one\ntwo */\nx\n", "c", CodeOptions::default());
        let with_comment: Vec<String> = rows(&html)
            .into_iter()
            .filter(|row| row.contains("hljs-comment"))
            .collect();
        assert_eq!(with_comment.len(), 2, "both rows are comments: {html}");
        assert!(with_comment[0].contains("one"), "{with_comment:?}");
        assert!(with_comment[1].contains("two"), "{with_comment:?}");
    }

    #[test]
    fn carriage_returns_become_newlines_before_numbering() {
        let html = render_code("a\r\nb\rc", "text_stub", CodeOptions::default());
        assert_eq!(rows(&html).len(), 3);
        assert!(!html.contains('\r'));
    }

    #[test]
    fn without_the_gutter_a_row_is_a_plain_line_wrapper() {
        let html = render_code("a\nb", "text_stub", CodeOptions { gutter: false });
        assert!(!html.contains("class=\"ln\""), "{html}");
        assert_eq!(html.matches("<span class=\"line\">").count(), 2);
    }

    #[test]
    fn the_source_decides_the_renderer_and_carries_its_markup() {
        let text = render_source(Path::new("/w/LICENSE"), "the license");
        assert_eq!(text.renderer, RendererName::Text);
        assert_eq!(text.html, None, "a text file carries no markup");
        assert_eq!(text.language, None);

        let html = render_source(Path::new("/w/page.html"), "<p>hi</p>");
        assert_eq!(html.renderer, RendererName::Html);
        assert_eq!(
            html.html, None,
            "a page comes from the html route, not from here"
        );

        let code = render_source(Path::new("/w/a.json"), "{\"a\": 1}");
        assert_eq!(code.renderer, RendererName::Code);
        assert_eq!(code.language.as_deref(), Some("json"));
        assert!(code.html.unwrap().contains("hljs-"));
    }
}
