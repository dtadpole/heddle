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
