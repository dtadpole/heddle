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
    todo!("port renderMarkdown from src/server/markdown.ts")
}

/// Render inline spans only — a title, a table cell, a label — through the same parser and the same allow-list.
pub fn render_inline(text: &str) -> String {
    todo!("port renderInline from src/server/markdown.ts")
}
