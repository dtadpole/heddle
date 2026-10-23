//! Markdown rendering — the port of `src/server/markdown.ts`.
//!
//! The TypeScript build parses with `marked` (GitHub-flavoured, `breaks` off) and keeps two guarantees on top of it,
//! because a document is untrusted text — from a model, a repository, or a person. The Rust port parses with a GFM
//! library (chosen in the crate's `INDEX.md`) and keeps the same two, with the same tests:
//!
//! 1. **The library's output is reduced to an allow-list** of elements and attributes ([`crate::sanitize`]), so a
//!    document cannot produce a tag of its own. Raw HTML in a document is passed through by the parser and reduced
//!    there, like everything else.
//! 2. **A link's scheme is checked** ([`safe_url`]): relative targets, fragments, `http`, `https` and `mailto`
//!    survive; a refused link keeps its label with ` (link refused)` beside it, and a refused image becomes its alt
//!    text.
//!
//! And the conventions this repository's documents need, each one a measured defect in the TypeScript history:
//!
//! - a leading YAML block is lifted into `<section class="frontmatter"><h2>frontmatter</h2><pre><code>…`;
//! - a lone leading `_` (as in `_tools_`) is escaped so a folder name keeps its underscores, outside code;
//! - a fence is highlighted by [`crate::highlight`] with `class="language-<name>"` on its `<code>`;
//! - a relative link or image resolves against the document's folder ([`MarkdownOptions::base`]) to
//!   `/api/raw?path=<encoded absolute path>`, and a link additionally carries the absolute path in
//!   [`LINK_DATA_ATTRIBUTE`] so the page opens it in the panel instead of navigating away;
//! - a remote link gets `target="_blank" rel="noreferrer noopener"`; a `data:` image is not resolved.

use std::path::Path;

use crate::sanitize::UrlSite;

/// The attribute a link to a workspace file carries the absolute path in, so the page can open it in the panel.
pub const LINK_DATA_ATTRIBUTE: &str = "data-heddle-path";

/// Escape the five characters that can start a tag, an entity, or a quote break-out: `& < > " '` become
/// `&amp; &lt; &gt; &quot; &#39;`.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Whether a link's target may be followed, and the trimmed target when it may.
///
/// `None` for an empty target and for any scheme other than `http`, `https` and `mailto` (compared
/// case-insensitively); a target with no scheme — relative, absolute-path, fragment — is returned trimmed.
pub fn safe_url(url: &str) -> Option<&str> {
    let trimmed = trim_js(url);
    if trimmed.is_empty() {
        return None;
    }
    match scheme_of(trimmed) {
        None => Some(trimmed),
        Some(scheme)
            if ["http", "https", "mailto"]
                .iter()
                .any(|allowed| scheme.eq_ignore_ascii_case(allowed)) =>
        {
            Some(trimmed)
        }
        Some(_) => None,
    }
}

/// The scheme of `url` when it starts with one — `/^[a-z][a-z0-9+.-]*:/i` — without its colon.
pub(crate) fn scheme_of(url: &str) -> Option<&str> {
    let mut characters = url.char_indices();
    match characters.next() {
        Some((_, first)) if first.is_ascii_alphabetic() => {}
        _ => return None,
    }
    for (index, character) in characters {
        if character == ':' {
            return Some(&url[..index]);
        }
        if !(character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')) {
            return None;
        }
    }
    None
}

/// JavaScript's `String.prototype.trim`.
///
/// JavaScript trims white space and line terminators; `char::is_whitespace` (Unicode `White_Space`) is the same set
/// except that it also holds U+0085 NEXT LINE, which JavaScript keeps, and lacks U+FEFF, which JavaScript trims.
pub(crate) fn trim_js(text: &str) -> &str {
    text.trim_matches(|character: char| {
        (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_html_escapes_exactly_the_five_characters() {
        assert_eq!(
            escape_html(r#"<a href="x">Tom & 'Jerry'</a>"#),
            "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;"
        );
        assert_eq!(escape_html("plain 文字 text"), "plain 文字 text");
        assert_eq!(
            escape_html("&amp;"),
            "&amp;amp;",
            "an entity is text, escaped again"
        );
    }

    #[test]
    fn safe_url_keeps_relative_targets_and_three_schemes() {
        assert_eq!(safe_url("  README.md "), Some("README.md"));
        assert_eq!(safe_url("#section"), Some("#section"));
        assert_eq!(safe_url("/abs/path"), Some("/abs/path"));
        assert_eq!(safe_url("HTTPS://example.com"), Some("HTTPS://example.com"));
        assert_eq!(safe_url("mailto:a@b.c"), Some("mailto:a@b.c"));
        assert_eq!(
            safe_url("./a:b"),
            Some("./a:b"),
            "a colon after a non-scheme character is not a scheme"
        );
    }

    #[test]
    fn safe_url_refuses_other_schemes_and_emptiness() {
        assert_eq!(safe_url("javascript:alert(1)"), None);
        assert_eq!(safe_url(" JavaScript:alert(1)"), None);
        assert_eq!(safe_url("data:text/html;base64,AAAA"), None);
        assert_eq!(safe_url("vbscript:x"), None);
        assert_eq!(safe_url("   "), None);
        assert_eq!(safe_url(""), None);
    }

    #[test]
    fn trim_js_matches_javascript_white_space() {
        assert_eq!(trim_js("\u{feff}\t x \u{2028}"), "x");
        assert_eq!(
            trim_js("\u{85}x"),
            "\u{85}x",
            "NEXT LINE is not white space to JavaScript"
        );
    }

    fn render(source: &str) -> String {
        render_markdown(source, MarkdownOptions::default())
    }

    fn render_at(path: &str, source: &str) -> String {
        // `base` is the document's own **folder**, which is what `render_source` passes.
        render_markdown(
            source,
            MarkdownOptions {
                base: Path::new(path).parent(),
            },
        )
    }

    /// Remove every tag, leaving the text a reader would see (entities still encoded).
    fn strip_tags(html: &str) -> String {
        let mut out = String::with_capacity(html.len());
        let mut in_tag = false;
        for character in html.chars() {
            match character {
                '<' => in_tag = true,
                '>' if in_tag => in_tag = false,
                other if !in_tag => out.push(other),
                _ => {}
            }
        }
        out
    }

    #[test]
    fn a_document_cannot_inject_markup() {
        let html = render("Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>");
        assert!(!html.contains("<script"), "no script tag survives: {html}");
        assert!(
            !html.contains("alert(1)"),
            "and its content is dropped: {html}"
        );
        assert!(
            !html.contains("onerror"),
            "an event handler cannot survive: {html}"
        );
        assert!(
            html.contains("<img src=\"x\">"),
            "the allowed attribute stays: {html}"
        );
    }

    #[test]
    fn a_link_that_would_run_script_is_refused_and_the_label_survives() {
        let html = render("[click](javascript:alert(1))");
        assert!(!html.contains("<a "), "no anchor is produced: {html}");
        assert!(
            html.contains("click (link refused)"),
            "the label and the reason: {html}"
        );
        assert!(
            !render("[x](data:text/html,<script>alert(1)</script>)").contains("<a "),
            "a data URL is refused too"
        );
        for url in [
            "https://example.com/a",
            "http://example.com",
            "mailto:someone@example.com",
            "docs/INDEX.md",
            "#a-heading",
        ] {
            assert!(
                render(&format!("[label]({url})")).contains("<a href="),
                "{url} is followed"
            );
        }
    }

    #[test]
    fn a_refused_link_keeps_its_rendered_label() {
        let html = render("[**danger**](javascript:alert(1))");
        assert!(!html.contains("<a "), "no anchor is produced: {html}");
        assert!(
            html.contains("<strong>danger</strong> (link refused)"),
            "the label is rendered, with the reason: {html}"
        );
    }

    #[test]
    fn headings_paragraphs_and_rules() {
        let html = render("# Title\n\nA paragraph.\n\n---\n\n## Second\n");
        assert!(html.contains("<h1>Title</h1>"), "{html}");
        assert!(html.contains("<p>A paragraph.</p>"), "{html}");
        assert!(html.contains("<hr />") || html.contains("<hr>"), "{html}");
        assert!(html.contains("<h2>Second</h2>"), "{html}");
    }

    #[test]
    fn emphasis_code_spans_and_strikethrough() {
        let html = render("Use **bold**, *italic*, `code`, and ~~gone~~.");
        assert!(html.contains("<strong>bold</strong>"), "{html}");
        assert!(html.contains("<em>italic</em>"), "{html}");
        assert!(html.contains("<code>code</code>"), "{html}");
        assert!(html.contains("<del>gone</del>"), "{html}");
    }

    #[test]
    fn emphasis_inside_a_code_span_stays_literal() {
        let html = render("The literal `a ** b` is multiplication.");
        assert!(
            html.contains("<code>a ** b</code>"),
            "the asterisks survive: {html}"
        );
        assert!(!html.contains("<strong>"), "and nothing is bolded: {html}");
    }

    #[test]
    fn a_fenced_block_keeps_its_language_and_its_text_exactly() {
        let html = render("```ts\nconst x: number = 1 < 2 ? a : b\n```");
        assert!(
            html.contains("<pre><code class=\"language-ts\">"),
            "the language is carried: {html}"
        );
        assert!(
            !html.contains("&amp;lt;"),
            "and the escaping is not applied twice: {html}"
        );
        let text = strip_tags(&html);
        assert!(
            text.trim() == "const x: number = 1 &lt; 2 ? a : b",
            "the code reads as it was written: {text:?} from {html}"
        );
    }

    #[test]
    fn a_fence_is_coloured_and_its_class_survives_the_allow_list() {
        let html = render("```python\ndef f(x):\n    return x if x else None\n```");
        assert!(
            html.contains("<pre><code class=\"language-python\">"),
            "{html}"
        );
        assert!(
            html.contains("hljs-keyword"),
            "the highlighter's spans survive: {html}"
        );
        assert!(
            !html.contains("<span onclick"),
            "and nothing forbidden gets through: {html}"
        );
    }

    #[test]
    fn an_unterminated_fence_still_renders_its_content() {
        let html = render("```\nno closing fence\n");
        assert!(html.contains("no closing fence"), "{html}");
        assert!(html.contains("<pre><code>"), "{html}");
    }

    #[test]
    fn consecutive_items_join_one_list() {
        let html = render("- one\n- two\n\n1. first\n2. second\n");
        assert_eq!(html.matches("<ul>").count(), 1, "{html}");
        assert_eq!(html.matches("<ol>").count(), 1, "{html}");
        assert_eq!(html.matches("<li>").count(), 4, "{html}");
    }

    #[test]
    fn a_table_renders_as_a_table_with_alignment() {
        let html = render(
            "| Part | Claims | State |\n| --- | ---: | :---: |\n| 1 | 10 | holds |\n| 2 | 6 | holds |\n",
        );
        assert_eq!(html.matches("<table>").count(), 1, "{html}");
        assert_eq!(
            html.matches("<th").count() - html.matches("<thead>").count(),
            3,
            "{html}"
        );
        assert_eq!(html.matches("<td").count(), 6, "{html}");
        assert!(html.contains("<th>Part</th>"), "{html}");
        assert!(
            html.contains("align=\"right\"") && html.contains(">Claims<"),
            "a right-aligned column says so: {html}"
        );
        assert!(
            html.contains("align=\"center\"") && html.contains(">State<"),
            "and a centred one: {html}"
        );
        assert!(!html.contains('|'), "no pipe is left as text: {html}");
    }

    #[test]
    fn a_table_is_not_read_where_there_is_no_delimiter_row() {
        let html = render("| a | b |\n| c | d |\n");
        assert!(!html.contains("<table>"), "no table is invented: {html}");
        assert!(
            html.contains("| a | b |"),
            "the text is shown as written: {html}"
        );
    }

    #[test]
    fn a_bolded_tag_does_not_become_a_tag() {
        let html = render("**<b>not bold</b>**");
        assert!(html.contains("<strong>not bold</strong>"), "{html}");
        assert!(
            !html.contains("<b>"),
            "the element the document wrote does not survive: {html}"
        );
    }

    #[test]
    fn a_documents_frontmatter_is_shown_as_metadata() {
        let html = render("---\ntitle: A Document\nversion: 1.0.0\n---\n\n# Heading\n\nBody.\n");
        assert!(
            html.contains("<section class=\"frontmatter\"><h2>frontmatter</h2><pre><code>"),
            "{html}"
        );
        assert!(html.contains("title: A Document"), "{html}");
        assert!(
            !html.contains("<p>title:"),
            "not rendered as a paragraph: {html}"
        );
        assert!(html.contains("<h1>Heading</h1>"), "{html}");
        assert!(
            !render("# Plain\n").contains("frontmatter"),
            "no frontmatter, no section"
        );
        assert!(
            render("text\n\n---\n\nmore").contains("<hr"),
            "a rule later is still a rule"
        );
    }

    #[test]
    fn a_name_that_begins_with_an_underscore_keeps_its_underscores() {
        assert!(
            render("# _tools_").contains("<h1>_tools_</h1>"),
            "a heading keeps the name"
        );
        assert!(
            render("See _verifiers_ for that.").contains("_verifiers_"),
            "and so does a sentence"
        );
        assert!(!render("_tools_").contains("<em>"), "nothing is emphasised");
        assert!(
            render("*italic* and **bold**").contains("<em>italic</em>"),
            "asterisks still emphasise"
        );
        assert!(
            render("a_b_c").contains("a_b_c"),
            "an underscore in a word was never at risk"
        );
    }

    #[test]
    fn an_escape_for_a_name_never_becomes_visible_inside_code() {
        let fenced = render("```python\nx = _a_b_\n```");
        assert!(
            !fenced.contains("\\_"),
            "no backslash reaches the fence: {fenced}"
        );
        assert!(fenced.contains("_a_b_"), "{fenced}");
        let span = render("the `_tools_` folder");
        assert!(!span.contains("\\_"), "{span}");
        assert!(span.contains("<code>_tools_</code>"), "{span}");
    }

    #[test]
    fn a_code_span_inside_link_text_is_code_not_literal_backticks() {
        let html = render("See [`_verifiers_/`](_verifiers_/INDEX.md) here.");
        assert!(
            html.contains("<code>_verifiers_/</code>"),
            "the label is a code element: {html}"
        );
        assert!(
            !html.contains("`"),
            "and no backtick survives as text: {html}"
        );
        assert!(
            render("[**bold** label](a.md)").contains("<strong>bold</strong> label"),
            "emphasis in a label"
        );
    }

    #[test]
    fn a_link_to_a_workspace_file_is_served_and_marked_for_the_panel() {
        // Measured in the TypeScript build: `[x](DEPLOY.md)` asked for `/DEPLOY.md`, which answered 404.
        let html = render_at("/w/docs/notes.md", "See [the index](../INDEX.md#part-two).");
        assert!(
            html.contains("href=\"/api/raw?path=%2Fw%2FINDEX.md#part-two\""),
            "the address is the route that serves the file: {html}"
        );
        assert!(
            html.contains("data-heddle-path=\"/w/INDEX.md\""),
            "with the absolute path for the panel to follow: {html}"
        );
        assert!(html.contains("rel=\"noreferrer noopener\""), "{html}");
    }

    #[test]
    fn a_remote_link_opens_beside_the_document() {
        let html = render_at("/w/a.md", "[out](https://example.com/x)");
        assert!(html.contains("href=\"https://example.com/x\""), "{html}");
        assert!(
            html.contains("target=\"_blank\""),
            "it opens in a new tab: {html}"
        );
        assert!(html.contains("rel=\"noreferrer noopener\""), "{html}");
    }

    #[test]
    fn an_image_is_resolved_beside_the_document() {
        let html = render_at("/w/_context_/notes.md", "![icon](heddle.svg)");
        assert!(
            html.contains("src=\"/api/raw?path=%2Fw%2F_context_%2Fheddle.svg\""),
            "the image is fetched from the route that serves it: {html}"
        );
        assert!(html.contains("alt=\"icon\""), "{html}");
        // A remote image is the author's choice and is left as written.
        assert!(
            render_at("/w/a.md", "![x](https://example.com/a.png)")
                .contains("src=\"https://example.com/a.png\""),
            "a remote image is untouched"
        );
    }

    #[test]
    fn a_raw_html_image_is_resolved_by_the_allow_lists_policy() {
        // Raw HTML goes around the renderer, so the sanitiser's policy is the one that resolves it.
        let html = render_at(
            "/w/docs/notes.md",
            "<p align=\"center\"><img src=\"heddle.svg\" width=\"160\"></p>",
        );
        assert!(
            html.contains("src=\"/api/raw?path=%2Fw%2Fdocs%2Fheddle.svg\""),
            "a hand-written image is resolved too: {html}"
        );
        assert!(
            html.contains("width=\"160\""),
            "and keeps a count of pixels: {html}"
        );
    }

    #[test]
    fn an_image_with_a_refused_source_becomes_its_alt_text() {
        let html = render_at("/w/a.md", "![the icon](javascript:alert(1))");
        assert!(!html.contains("<img"), "nothing is fetched: {html}");
        assert!(
            html.contains("the icon"),
            "and the author's words still read: {html}"
        );
    }

    #[test]
    fn a_bare_url_is_an_autolink() {
        // The GFM behaviour the library choice was made for: a document's bare URL is a link, as GitHub renders it.
        let html = render("See https://example.com/x for that.");
        assert!(html.contains("href=\"https://example.com/x\""), "{html}");
    }

    #[test]
    fn render_inline_answers_spans_only() {
        let html = render_inline("Use **bold** and `code`");
        assert!(!html.contains("<p>"), "no paragraph wrapper: {html}");
        assert!(html.contains("<strong>bold</strong>"), "{html}");
        assert!(html.contains("<code>code</code>"), "{html}");
        assert_eq!(render_inline("plain"), "plain");
        assert_eq!(
            render_inline("[x](javascript:alert(1))"),
            "<a>x</a>",
            "an inline link loses its refused address, as the TypeScript build's does"
        );
    }

    #[test]
    fn rendering_is_repeatable_and_empty_input_is_empty_output() {
        let source = "# A\n\ntext with `code`\n";
        assert_eq!(render(source), render(source), "no state to drift");
        assert_eq!(render(""), "", "nothing in gives nothing out");
    }

    #[test]
    fn resolve_against_normalises_and_never_climbs_above_the_root() {
        assert_eq!(
            resolve_against(Path::new("/w/docs"), "../INDEX.md"),
            "/w/INDEX.md"
        );
        assert_eq!(resolve_against(Path::new("/w"), "../../x"), "/x");
        assert_eq!(resolve_against(Path::new("/w"), "./a/./b"), "/w/a/b");
        assert_eq!(resolve_against(Path::new("/"), "a"), "/a");
    }

    #[test]
    fn percent_encoding_matches_encode_uri_component() {
        assert_eq!(
            percent_encode("/w/a b/文字.md"),
            "%2Fw%2Fa%20b%2F%E6%96%87%E5%AD%97.md"
        );
        assert_eq!(percent_encode("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(percent_decode("%2Fw%2Fa%20b"), "/w/a b");
        assert_eq!(
            percent_decode("100%"),
            "100%",
            "a stray percent is left as written"
        );
    }

    #[test]
    fn split_frontmatter_matches_the_typescript_expression() {
        assert_eq!(
            split_frontmatter("---\na: 1\n---\nbody"),
            (Some("a: 1"), "body")
        );
        assert_eq!(split_frontmatter("---\na: 1\n---"), (Some("a: 1"), ""));
        assert_eq!(
            split_frontmatter("no frontmatter"),
            (None, "no frontmatter")
        );
        assert_eq!(
            split_frontmatter("---\nnot closed\n"),
            (None, "---\nnot closed\n"),
            "an unclosed block is left to the parser"
        );
    }
}

/// Per-document rendering options.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MarkdownOptions<'a> {
    /// The document's own folder: relative links and images resolve against it. `None` leaves them as written —
    /// which is what a transcript row and `POST /api/markdown` want, since that text has no folder.
    ///
    /// Passed per call, where the TypeScript build used a module-level variable set before each parse; the Rust
    /// renderer is therefore safe to call from several requests at once.
    pub base: Option<&'a Path>,
}

/// Render a document to sanitized HTML.
///
/// `\r\n` and `\r` become `\n` first; a leading `---\n…\n---` block becomes the frontmatter section; the rest is
/// parsed as GFM (tables, task lists, strikethrough, autolinks; a single newline is a space) and the whole output
/// passes through [`crate::sanitize::sanitize_html`] with a URL policy that applies [`safe_url`] and resolves
/// relative references against `options.base` — for raw HTML tags as well as for markdown links and images.
pub fn render_markdown(source: &str, options: MarkdownOptions<'_>) -> String {
    let text = source.replace("\r\n", "\n").replace('\r', "\n");
    let (front, body) = split_frontmatter(&text);
    let prepared = escape_leading_underscores(body);
    let comrak_options = comrak_options();
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, &prepared, &comrak_options);
    rewrite_destinations(root, options.base);
    let highlighter = FilesHighlighter;
    let mut plugins = comrak::Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&highlighter);
    let mut bytes: Vec<u8> = Vec::new();
    // Writing into a byte vector cannot fail; a failure would leave the part already written, which is still HTML.
    let _ = comrak::html::format_document_with_plugins(root, &comrak_options, &mut bytes, &plugins);
    let rendered = rewrite_anchors(&String::from_utf8_lossy(&bytes));
    let front_html = match front {
        Some(yaml) => format!(
            "<section class=\"frontmatter\"><h2>frontmatter</h2><pre><code>{}</code></pre></section>\n",
            escape_html(trim_js(yaml))
        ),
        None => String::new(),
    };
    let base = options.base;
    let policy = move |value: &str, _site: UrlSite<'_>| url_for(value, base);
    crate::sanitize::sanitize_html(
        &(front_html + &rendered),
        crate::sanitize::SanitizeOptions { url: Some(&policy) },
    )
}

/// Render inline spans only — a title, a table cell, a label — through the same parser and the same allow-list.
pub fn render_inline(text: &str) -> String {
    let prepared = escape_leading_underscores(text);
    let rendered = comrak::markdown_to_html(&prepared, &comrak_options());
    let body = unwrap_paragraph(&rendered);
    let policy = |value: &str, _site: UrlSite<'_>| safe_url(value).map(str::to_string);
    crate::sanitize::sanitize_html(
        &body,
        crate::sanitize::SanitizeOptions { url: Some(&policy) },
    )
}

/// The URL a refused destination is rewritten to before rendering, so the rewrite is one pass over the output.
///
/// A scheme neither `safe_url` nor a browser follows, and one this crate writes nowhere else: the marker cannot be
/// produced by a document, so the pass only ever acts on a destination this crate refused.
const REFUSED: &str = "heddle-refused:";

/// The parser's options: GitHub's dialect, and raw HTML passed through so the allow-list can judge it.
fn comrak_options() -> comrak::Options<'static> {
    let mut options = comrak::Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    // A document's own HTML is parsed and passed through, then reduced by the allow-list: the safety guarantee sits
    // on the output, where it belongs when the parser is someone else's code.
    options.render.unsafe_ = true;
    options.render.escape = false;
    options.render.hardbreaks = false;
    options.render.github_pre_lang = false;
    options
}

/// The highlighter, as the code-fence plugin `comrak` calls.
struct FilesHighlighter;

impl comrak::adapters::SyntaxHighlighterAdapter for FilesHighlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn std::io::Write,
        lang: Option<&str>,
        code: &str,
    ) -> std::io::Result<()> {
        output.write_all(crate::highlight::highlight_code(code, lang).as_bytes())
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn std::io::Write,
        attributes: std::collections::HashMap<String, String>,
    ) -> std::io::Result<()> {
        output.write_all(format!("<pre{}>", render_attributes(&attributes)).as_bytes())
    }

    fn write_code_tag(
        &self,
        output: &mut dyn std::io::Write,
        attributes: std::collections::HashMap<String, String>,
    ) -> std::io::Result<()> {
        output.write_all(format!("<code{}>", render_attributes(&attributes)).as_bytes())
    }
}

/// The attributes `comrak` offers, in a stable order, escaped — the one place a fence's markup is written.
fn render_attributes(attributes: &std::collections::HashMap<String, String>) -> String {
    let mut pairs: Vec<String> = attributes
        .iter()
        .map(|(name, value)| format!(" {name}=\"{}\"", escape_html(value)))
        .collect();
    pairs.sort();
    pairs.concat()
}

/// Points every relative destination at the route that serves it, and marks a refused one for the rewrite.
///
/// A link to a workspace file keeps a **served** address, so its status bar and a middle click still point at the
/// bytes, and the panel opens it in place; an image is resolved so a document's `![](icon.svg)` looks beside the
/// document rather than at the server root.
fn rewrite_destinations<'a>(root: &'a comrak::nodes::AstNode<'a>, base: Option<&Path>) {
    let nodes: Vec<&'a comrak::nodes::AstNode<'a>> = root.descendants().collect();
    // Deepest first, so an image inside a label is already rewritten when the label is.
    for node in nodes.into_iter().rev() {
        let mut data = node.data.borrow_mut();
        let link = match &mut data.value {
            comrak::nodes::NodeValue::Link(link) | comrak::nodes::NodeValue::Image(link) => link,
            _ => continue,
        };
        let Some(target) = safe_url(&link.url).map(str::to_string) else {
            link.url = REFUSED.to_string();
            continue;
        };
        if let Some(resolved) = resolve_subresource(&target, base) {
            link.url = raw_url(&resolved);
        } else {
            link.url = target;
        }
    }
}

/// One pass over the rendered document: adds the attributes `comrak` cannot, and removes a refused anchor.
///
/// A destination that is a **file beside the document** carries its path in [`LINK_DATA_ATTRIBUTE`], which is how
/// the panel knows to open it rather than navigate; a remote link opens beside the document; a refused link keeps
/// its rendered label with the reason beside it, and a refused image becomes its alt text.
fn rewrite_anchors(html: &str) -> String {
    let mut out = String::with_capacity(html.len() + 64);
    let mut index = 0usize;
    while index < html.len() {
        let Some(at) = html[index..].find('<').map(|offset| index + offset) else {
            out.push_str(&html[index..]);
            break;
        };
        out.push_str(&html[index..at]);
        if html[at..].starts_with("<a ") {
            let Some(end) = tag_end(html, at) else {
                out.push_str(&html[at..]);
                break;
            };
            let tag = &html[at..end];
            let Some(href) = attribute_value(tag, "href") else {
                out.push_str(tag);
                index = end;
                continue;
            };
            if href == REFUSED {
                // Drop the anchor and keep what it wrapped, then say what became of it.
                let Some(close) = html[end..].find("</a>").map(|offset| end + offset) else {
                    out.push_str(&html[at..end]);
                    index = end;
                    continue;
                };
                out.push_str(&html[end..close]);
                out.push_str(" (link refused)");
                index = close + 4;
                continue;
            }
            out.push_str(&annotate(tag, &href));
            index = end;
            continue;
        }
        if html[at..].starts_with("<img ") {
            let Some(end) = tag_end(html, at) else {
                out.push_str(&html[at..]);
                break;
            };
            let tag = &html[at..end];
            if attribute_value(tag, "src").as_deref() == Some(REFUSED) {
                // A refused image becomes its alt text: nothing is fetched, and the author's words still read.
                match attribute_value(tag, "alt") {
                    Some(alt) => out.push_str(&alt),
                    None => out.push_str(tag),
                }
                index = end;
                continue;
            }
            out.push_str(tag);
            index = end;
            continue;
        }
        out.push('<');
        index = at + 1;
    }
    out
}

/// The same anchor tag with the attributes this project adds — or the path attribute for a served file.
fn annotate(tag: &str, href: &str) -> String {
    let mut extra = String::new();
    if let Some(path) = href.strip_prefix("/api/raw?path=") {
        let path = path.split('#').next().unwrap_or(path);
        extra.push_str(&format!(
            " {}=\"{}\"",
            LINK_DATA_ATTRIBUTE,
            escape_html(&percent_decode(path))
        ));
    }
    let external =
        href.starts_with("http://") || href.starts_with("https://") || href.starts_with("//");
    if external {
        extra.push_str(" target=\"_blank\"");
    }
    extra.push_str(" rel=\"noreferrer noopener\"");
    let Some(end) = tag.rfind('>') else {
        return tag.to_string();
    };
    format!("{}{}{}", &tag[..end], extra, &tag[end..])
}

/// The byte after the `>` that ends the tag beginning at `at`, honouring a quoted attribute's `>`.
fn tag_end(html: &str, at: usize) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut index = at + 1;
    let mut quote: Option<u8> = None;
    while index < bytes.len() {
        match (quote, bytes[index]) {
            (Some(open), byte) if byte == open => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(bytes[index]),
            (None, b'>') => return Some(index + 1),
            (None, _) => {}
        }
        index += 1;
    }
    None
}

/// A tag's attribute value as written (still escaped), by name.
fn attribute_value(tag: &str, name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut index = 0usize;
    while index + name.len() <= bytes.len() {
        if !tag[index..].starts_with(name) {
            index += 1;
            continue;
        }
        let boundary = index == 0 || bytes[index - 1].is_ascii_whitespace();
        let mut cursor = index + name.len();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if !boundary || bytes.get(cursor) != Some(&b'=') {
            index += 1;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = *bytes.get(cursor)?;
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        let rest = &tag[cursor + 1..];
        let end = rest.find(quote as char)?;
        return Some(rest[..end].to_string());
    }
    None
}

/// A leading YAML block, and the body after it.
fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return (None, text);
    };
    let Some(at) = rest.find("\n---") else {
        return (None, text);
    };
    let content = &rest[..at];
    let after = &rest[at + 4..];
    match after.strip_prefix('\n') {
        Some(tail) => (Some(content), tail),
        None => (Some(content), after),
    }
}

/// A leading `_` is escaped, so a name is a name: `_tools_` is not emphasis.
///
/// Code is left alone, because a backslash **inside code is visible**: an escape that changes the text of code is
/// worse than the emphasis it prevents. Code spans keep their underscores without help, since emphasis does not run
/// inside them.
fn escape_leading_underscores(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len() + 16);
    let mut fence: Option<&str> = None;
    for (index, line) in markdown.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        if let Some(marker) = fence_marker(line) {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                Some(_) => {}
            }
            out.push_str(line);
            continue;
        }
        if fence.is_some() {
            out.push_str(line);
            continue;
        }
        for piece in split_code_spans(line) {
            if piece.starts_with('`') {
                out.push_str(piece);
            } else {
                escape_leading_underscores_in(piece, &mut out);
            }
        }
    }
    out
}

/// `/^\s*(```|~~~)/`: the fence marker a line opens with, if any.
fn fence_marker(line: &str) -> Option<&'static str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") {
        Some("```")
    } else if trimmed.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

/// Split a line at its code spans, keeping the backticks: ``a `b` c`` is `a `, `` `b` ``, ` c`.
fn split_code_spans(line: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0usize;
    let bytes = line.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'`' {
            index += 1;
            continue;
        }
        let Some(close) = line[index + 1..].find('`') else {
            break;
        };
        let end = index + 1 + close + 1;
        pieces.push(&line[start..index]);
        pieces.push(&line[index..end]);
        start = end;
        index = end;
    }
    pieces.push(&line[start..]);
    pieces
}

/// `(^|\s)_(?=[^\s_])` → `\_`: a leading underscore of a name becomes literal, and everything else is left alone.
fn escape_leading_underscores_in(text: &str, out: &mut String) {
    let mut previous: Option<char> = None;
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '_' {
            let leading = previous.is_none_or(|before| before.is_whitespace());
            let followed = characters
                .peek()
                .is_some_and(|next| !next.is_whitespace() && *next != '_');
            if leading && followed {
                out.push('\\');
            }
        }
        out.push(character);
        previous = Some(character);
    }
}

/// A relative reference resolved against the document's folder, or `None` when it is not this server's to resolve.
struct Subresource {
    path: String,
    fragment: String,
}

/// The file a relative reference names, or `None` for a remote URL, a `data:` payload, a fragment, or no base.
fn resolve_subresource(href: &str, base: Option<&Path>) -> Option<Subresource> {
    let trimmed = href.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    // A remote URL is the author's choice, and a `data:` image is a payload rather than a file.
    if trimmed.starts_with("//")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || trimmed.starts_with("data:")
    {
        return None;
    }
    // A fragment is a place inside this document, not a file beside it.
    if trimmed.starts_with('#') {
        return None;
    }
    let base = base?;
    let (target, fragment) = match trimmed.split_once('#') {
        Some((target, fragment)) => (target, fragment),
        None => (trimmed, ""),
    };
    let path = if target.starts_with('/') {
        target.to_string()
    } else {
        resolve_against(base, target)
    };
    Some(Subresource {
        path,
        fragment: fragment.to_string(),
    })
}

/// Join `target` to `base` lexically: `.` is dropped and `..` pops, but never above the root.
fn resolve_against(base: &Path, target: &str) -> String {
    let base = base.to_string_lossy();
    let mut segments: Vec<&str> = Vec::new();
    for segment in base.split('/').chain(target.split('/')) {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    format!("/{}", segments.join("/"))
}

/// The route that serves a file's bytes, which is what an `<img>` and a followed link both need.
fn raw_url(resolved: &Subresource) -> String {
    let mut url = format!("/api/raw?path={}", percent_encode(&resolved.path));
    if !resolved.fragment.is_empty() {
        url.push('#');
        url.push_str(&resolved.fragment);
    }
    url
}

/// `encodeURIComponent`: every byte but an unreserved one is percent-encoded, upper-case hex.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`, total: a stray `%` or an invalid sequence is left as written rather than refused.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The destination a URL attribute keeps: `safe_url`, then a relative reference is pointed at the raw route.
fn url_for(value: &str, base: Option<&Path>) -> Option<String> {
    let safe = safe_url(value)?;
    let relative = scheme_of(safe).is_none() && !safe.starts_with('/') && !safe.starts_with('#');
    if !relative {
        return Some(safe.to_string());
    }
    match resolve_subresource(safe, base) {
        Some(resolved) => Some(raw_url(&resolved)),
        None => Some(safe.to_string()),
    }
}

/// Strip the paragraph a single line of inline markdown is wrapped in, so `render_inline` answers spans only.
fn unwrap_paragraph(rendered: &str) -> String {
    if rendered.matches("<p>").count() == 1 && rendered.ends_with("</p>\n") {
        let start = rendered.find("<p>").map_or(0, |at| at + 3);
        return rendered[start..rendered.len() - 5].to_string();
    }
    rendered.to_string()
}
