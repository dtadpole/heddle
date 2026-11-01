//! Previewing an HTML document safely — the port of `src/server/html.ts`, and the `/api/html` and
//! `/vendor/purify.js` routes of `src/server/web.ts`.
//!
//! This is the one renderer that has to execute nothing, so the design has three parts:
//!
//! 1. **The document is sanitised in the browser, by DOMPurify**, with the allow-lists below (served at
//!    `/vendor/purify.js` from the installed `dompurify` package, not vendored).
//! 2. **It is shown in a sandboxed iframe** with `allow-same-origin` and no `allow-scripts`, under
//!    [`PREVIEW_CSP`].
//! 3. **The server rewrites the document's relative resources** to the route that serves them
//!    (`/api/raw?path=…`), before the sanitiser sees them. The shared page injects no base (#40), as in DSH's
//!    basic static HTML preview: `base-uri 'none'` stays enforced. Source base start tags are removed before
//!    browser parsing to avoid CSP violations in DOMPurify's detached parse; DOMPurify still sanitises the
//!    result. CSS url()/@import dependency rewriting is not supported; a filesystem-folder base never
//!    served those dependencies through the raw route either.
//!
//! The page holds the allow-lists itself; these constants are the server's copy of the same policy, kept so
//! the two can be compared by a test rather than by eye.

use std::path::{Path, PathBuf};

/// The elements a preview may contain. Anything outside it is dropped.
#[rustfmt::skip]
pub const ALLOWED_TAGS: &[&str] = &[
    "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "col",
    "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
    "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd",
    "label", "legend", "li", "main", "mark", "nav", "ol", "p", "picture", "pre", "q", "s", "samp",
    "section", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
    "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr", "link", "style",
];

/// The attributes those elements may carry.
#[rustfmt::skip]
pub const ALLOWED_ATTRS: &[&str] = &[
    "abbr", "align", "alt", "class", "colspan", "dir", "height", "href", "hreflang", "id", "lang",
    "media", "name", "rel", "role", "sizes", "span", "src", "srcset", "start", "style", "summary",
    "title", "type", "valign", "width",
];

/// The resources a document may pull in, as the case-insensitive pattern DOMPurify tests each URL against.
pub const ALLOWED_URI_PATTERN: &str = r"^(?:https?:|\/|\.{1,2}\/|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))";

/// The resource policy a previewed document runs under in the fixed shell's response header.
pub const PREVIEW_CSP: &str = "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; media-src 'self' https:; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

/// A fixed empty document, never populated with request paths or workspace bytes by the server.
pub const PREVIEW_SHELL: &str = "<!doctype html><html><head></head><body></body></html>\n";

pub fn frame_policy() -> String {
    format!("{PREVIEW_CSP}; frame-ancestors 'self'; sandbox allow-same-origin")
}

/// The largest document `/api/html` prepares: 4 MiB, answered `413` above it.
pub const MAX_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;

/// Where DOMPurify's browser build is found under an installation root.
pub const PURIFY_RELATIVE_PATH: &str = "node_modules/dompurify/dist/purify.min.js";

/// `encodeURIComponent`: the unreserved marks it keeps are `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
fn encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Whether a URL begins with a scheme, as `/^[a-z][a-z0-9+.-]*:/i` tests it.
fn has_scheme(url: &str) -> bool {
    let mut chars = url.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for candidate in chars {
        if candidate == ':' {
            return true;
        }
        if !(candidate.is_ascii_alphanumeric() || matches!(candidate, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// A path split at its `#`, so a fragment is not treated as part of the filename.
fn split_at_fragment(url: &str) -> (&str, &str) {
    match url.find('#') {
        Some(at) => (&url[..at], &url[at..]),
        None => (url, ""),
    }
}

/// A path joined to the folder of the document that referred to it, without a filesystem.
fn join_path(base: &str, relative: &str) -> String {
    let joined = format!("{base}/{relative}");
    let mut out: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        if part.is_empty() {
            if out.is_empty() {
                out.push("");
            }
            continue;
        }
        if part == "." {
            continue;
        }
        if part == ".." {
            if out.len() > 1 {
                out.pop();
            }
            continue;
        }
        out.push(part);
    }
    out.join("/")
}

/// Whether a path is a document the page previews as a page: an `.html` or `.htm` file, by extension.
///
/// DSH registers its HTML renderer for exactly these two extensions (`dsh-client-ui-sidebar-documentpreview`,
/// `extensions: ["html", "htm"]`); a `.docx` goes to its Office renderer and anything else to its own renderer or
/// plain text, so no other file is ever framed as a page. `GET /api/html` refuses the rest with `415`, the same
/// answer as `web.ts`, rather than failing on whatever the bytes happen to be.
pub fn is_html_document(path: &Path) -> bool {
    let Some(leaf) = path.file_name().and_then(|leaf| leaf.to_str()) else {
        return false;
    };
    match leaf.rfind('.') {
        Some(dot) if dot > 0 => {
            let extension = leaf[dot + 1..].to_ascii_lowercase();
            extension == "html" || extension == "htm"
        }
        _ => false,
    }
}

/// The sentence `GET /api/html` answers, with `415`, for a file that is not an HTML document (`web.ts`'s
/// `NOT_AN_HTML_DOCUMENT`).
pub const NOT_AN_HTML_DOCUMENT: &str =
    "not an HTML document; only .html and .htm files are previewed as a page";

/// The address `/api/html` points a rewritten resource at: `/api/raw?path=<percent-encoded path>`, encoded
/// the way `encodeURIComponent` encodes.
pub fn raw_route(path: &str) -> String {
    format!("/api/raw?path={}", encode_component(path))
}

/// Rewrite a document's relative resources to the route that serves them.
///
/// The quoted values of `src` and `href` attributes (a whitespace character, the name in any case,
/// optional spaces around `=`, then a single- or double-quoted value) and every candidate URL of a
/// `srcset` are rewritten; a value that is empty, has a scheme, or starts with `//`, `/` or `#` is left
/// alone. A relative value is joined to `base` without a filesystem (`.` dropped, `..` pops but never above
/// the root), its `#fragment` kept apart, and passed to `serve`.
pub fn rewrite_resources(html: &str, base: &str, serve: &dyn Fn(&str) -> String) -> String {
    let rewrite_url = |value: &str| -> String {
        let trimmed = value.trim();
        if trimmed.is_empty() || has_scheme(trimmed) {
            return value.to_owned();
        }
        if trimmed.starts_with("//") || trimmed.starts_with('/') || trimmed.starts_with('#') {
            return value.to_owned();
        }
        let (path, fragment) = split_at_fragment(trimmed);
        format!("{}{fragment}", serve(&join_path(base, path)))
    };

    let source = strip_source_base(html);
    let html = source.as_str();
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut index = 0;
    while index < bytes.len() {
        // An attribute is a whitespace character, the name, optional spaces, `=`, optional spaces, a quote.
        if !bytes[index].is_ascii_whitespace() {
            push_char(html, &mut out, &mut index);
            continue;
        }
        let attempt = attribute_at(html, index);
        let Some((name, quote, value_start)) = attempt else {
            push_char(html, &mut out, &mut index);
            continue;
        };
        if !matches!(name.as_str(), "src" | "href" | "srcset") {
            push_char(html, &mut out, &mut index);
            continue;
        }
        let Some(value_end) = html[value_start..].find(quote).map(|end| value_start + end) else {
            push_char(html, &mut out, &mut index);
            continue;
        };
        let value = &html[value_start..value_end];
        let rewritten = if name == "srcset" {
            value
                .split(',')
                .map(|candidate| {
                    let mut parts = candidate.split_whitespace();
                    let url = parts.next().unwrap_or("");
                    let mut rebuilt = rewrite_url(url);
                    for descriptor in parts {
                        rebuilt.push(' ');
                        rebuilt.push_str(descriptor);
                    }
                    rebuilt
                })
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            rewrite_url(value)
        };
        out.push_str(&html[index..value_start]);
        out.push_str(&rewritten);
        out.push(quote);
        index = value_end + quote.len_utf8();
    }
    out
}

/// Compatibility preprocessing, not sanitisation: DOMPurify's detached parse can apply a source
/// base before FORBID_TAGS removes it, violating the outer page's base-uri CSP. Scan source tokens
/// without a DOM and drop only base start tags, preserving comments, attributes and raw/RCDATA text.
/// Escape a trailing DATA-state '<' at each removal boundary to avoid creating new markup while
/// preserving rendered text, without output rescans or fixed-point loops. DOMPurify, the iframe sandbox
/// and unchanged CSP remain the security boundaries; foreign-namespace tokenizer transitions (N2)
/// are not modeled. The markdown allow-list scanner is destructive and cannot preserve the source.
fn strip_source_base(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut kept = 0;
    let mut index = 0;
    let mut raw = String::new();
    while index < bytes.len() {
        let Some(open) = html[index..].find('<').map(|at| index + at) else {
            break;
        };
        if raw.is_empty() && html[open..].starts_with("<!--") {
            let mut cursor = open + 4;
            if bytes.get(cursor) == Some(&b'>') {
                cursor += 1;
            } else if bytes[cursor..].starts_with(b"->") {
                cursor += 2;
            } else {
                while cursor < bytes.len()
                    && !bytes[cursor..].starts_with(b"-->")
                    && !bytes[cursor..].starts_with(b"--!>")
                {
                    cursor += 1;
                }
                cursor = (cursor
                    + if bytes[cursor..].starts_with(b"--!>") {
                        4
                    } else {
                        3
                    })
                .min(bytes.len());
            }
            index = cursor;
            continue;
        }
        let closing = bytes.get(open + 1) == Some(&b'/');
        let start = open + if closing { 2 } else { 1 };
        if !bytes.get(start).is_some_and(u8::is_ascii_alphabetic) {
            if raw.is_empty() && (matches!(bytes.get(open + 1), Some(b'!' | b'?')) || closing) {
                index = html[start..]
                    .find('>')
                    .map_or(bytes.len(), |at| start + at + 1);
            } else {
                index = open + 1;
            }
            continue;
        }
        let mut cursor = start;
        while cursor < bytes.len()
            && !html_space(bytes[cursor])
            && !matches!(bytes[cursor], b'/' | b'>')
        {
            cursor += 1;
        }
        let name = html[start..cursor].to_ascii_lowercase();
        if !raw.is_empty() && (!closing || name != raw) {
            index = open + 1;
            continue;
        }
        let Some(end) = source_tag_end(bytes, cursor) else {
            break; // An unfinished tag is not emitted by the browser tokenizer.
        };
        index = end;
        if !raw.is_empty() {
            raw.clear();
        } else if !closing && name == "base" {
            // A '<' before this DATA-state token was literal text; do not splice it into new markup.
            // Empty slices after adjacent bases are already protected by the earlier removal.
            if open > kept && bytes[open - 1] == b'<' {
                out.push_str(&html[kept..open - 1]);
                out.push_str("&lt;");
            } else {
                out.push_str(&html[kept..open]);
            }
            kept = end;
        } else if !closing
            && matches!(
                name.as_str(),
                "script"
                    | "style"
                    | "title"
                    | "textarea"
                    | "xmp"
                    | "iframe"
                    | "noembed"
                    | "noframes"
            )
        {
            raw = name;
        } else if !closing && name == "plaintext" {
            break;
        }
    }
    out.push_str(&html[kept..]);
    out
}

fn html_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

/// Scan attributes so > inside quoted values is not mistaken for a tag boundary.
fn source_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    #[derive(Clone, Copy)]
    enum State {
        Before,
        Name,
        After,
        Value,
        Unquoted,
        Quoted(u8),
    }
    let mut state = State::Before;
    for (cursor, &byte) in bytes.iter().enumerate().skip(start) {
        if let State::Quoted(quote) = state {
            if byte == quote {
                state = State::Before;
            }
            continue;
        }
        if byte == b'>' {
            return Some(cursor + 1);
        }
        match state {
            State::Unquoted => {
                if html_space(byte) {
                    state = State::Before;
                }
            }
            State::Value => {
                if html_space(byte) {
                    continue;
                }
                state = if matches!(byte, b'\"' | b'\'') {
                    State::Quoted(byte)
                } else {
                    State::Unquoted
                };
            }
            State::Name | State::After => {
                state = if byte == b'=' {
                    State::Value
                } else if html_space(byte) {
                    State::After
                } else if byte == b'/' {
                    State::Before
                } else {
                    State::Name
                };
            }
            State::Before => {
                if !html_space(byte) && byte != b'/' {
                    state = State::Name;
                }
            }
            State::Quoted(_) => unreachable!(),
        }
    }
    None
}

/// Push the character at `index` and advance past its UTF-8 bytes.
fn push_char(html: &str, out: &mut String, index: &mut usize) {
    let ch = html[*index..]
        .chars()
        .next()
        .expect("a character at a boundary");
    out.push(ch);
    *index += ch.len_utf8();
}

/// The attribute starting at whitespace `start`: its name, the `=`, the quote, and where the value starts.
fn attribute_at(html: &str, start: usize) -> Option<(String, char, usize)> {
    let bytes = html.as_bytes();
    let mut index = start;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    let name_start = index;
    while index < bytes.len()
        && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_'))
    {
        index += 1;
    }
    if index == name_start {
        return None;
    }
    let name = html[name_start..index].to_ascii_lowercase();
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b'=' {
        return None;
    }
    index += 1;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || (bytes[index] != b'"' && bytes[index] != b'\'') {
        return None;
    }
    let quote = char::from(bytes[index]);
    Some((name, quote, index + 1))
}

/// DOMPurify as the binary carries it: the same file as the installed `dompurify` package the TypeScript build serves
/// (3.4.16, pinned by package-lock.json), with its licence header, embedded as `page.html` is.
///
/// Live issue #39 (developer-two-8, 2026-10-29): `/vendor/purify.js` was looked for only under `node_modules` beside
/// the binary's repository or working directory. The Rust preview's checkout had no `node_modules`, so the route
/// answered 404 and every HTML document was shown as its source; a deployment had to copy the file in. A binary now
/// serves this copy when no installed one is found; a unit test keeps it equal to the installed package.
pub const EMBEDDED_PURIFY: &str = include_str!("../assets/purify.min.js");

/// Where `/vendor/purify.js` is read from, first existing wins: each root in `roots` joined with
/// [`PURIFY_RELATIVE_PATH`]. The binary passes the repository it was built from and the working
/// directory; a build without the package serves [`EMBEDDED_PURIFY`].
pub fn purify_path(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join(PURIFY_RELATIVE_PATH))
        .find(|candidate| candidate.is_file())
}

/// The grammars the page's code-block highlighter loads: exactly the set `src/server/highlight.ts` registers, so
/// a fence is coloured the same in the page whichever server drew it (C60).
pub const HIGHLIGHT_GRAMMARS: [&str; 20] = [
    "bash",
    "c",
    "cpp",
    "css",
    "diff",
    "go",
    "ini",
    "java",
    "javascript",
    "json",
    "markdown",
    "php",
    "plaintext",
    "python",
    "ruby",
    "rust",
    "sql",
    "typescript",
    "xml",
    "yaml",
];

/// One highlight.js module for the page, as the TypeScript route serves it, or `None` for any other name:
/// `core.js` (the package's CommonJS core, which has no `require`, wrapped as an ES module) and
/// `languages/<name>.js` for a grammar in [`HIGHLIGHT_GRAMMARS`] (the package's standalone ES grammar). Read from
/// the first root holding `node_modules/highlight.js`.
pub fn highlight_asset(roots: &[PathBuf], name: &str) -> Option<String> {
    let package = roots
        .iter()
        .map(|root| root.join("node_modules/highlight.js"))
        .find(|candidate| candidate.join("lib/core.js").is_file())?;
    if name == "core.js" {
        let core = std::fs::read_to_string(package.join("lib/core.js")).ok()?;
        return Some(format!(
            "const module = {{ exports: {{}} }};\nconst exports = module.exports;\n{core}\nexport default module.exports;\n"
        ));
    }
    let grammar = name.strip_prefix("languages/")?.strip_suffix(".js")?;
    if !HIGHLIGHT_GRAMMARS.contains(&grammar) {
        return None;
    }
    std::fs::read_to_string(package.join("es/languages").join(format!("{grammar}.js"))).ok()
}

/// The answer `/api/html` gives for a readable document: `{ path, html, csp, bytes }`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PreparedDocument {
    pub path: String,
    pub html: String,
    pub csp: &'static str,
    pub bytes: u64,
}

/// Prepare one document for the preview pane: its relative resources rewritten to [`raw_route`] against
/// the document's own folder, with [`PREVIEW_CSP`]. The caller has already checked that the path is under
/// a workspace root and is a file no larger than [`MAX_PREVIEW_BYTES`].
pub fn prepare_document(path: &Path, source: &str, bytes: u64) -> PreparedDocument {
    let base = path
        .parent()
        .map(|parent| parent.display().to_string())
        .unwrap_or_default();
    PreparedDocument {
        path: path.display().to_string(),
        html: rewrite_resources(source, &base, &raw_route),
        csp: PREVIEW_CSP,
        bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serve(path: &str) -> String {
        raw_route(path)
    }

    #[test]
    fn only_an_html_or_htm_file_is_a_page_to_preview() {
        for path in ["/w/page.html", "/w/PAGE.HTM", "/w/a.b/index.Html"] {
            assert!(is_html_document(Path::new(path)), "{path}");
        }
        // A Word document goes to DSH's Office renderer, text to its own; none is framed as a page.
        for path in [
            "/w/report.docx",
            "/w/notes.txt",
            "/w/readme.md",
            "/w/page.html.bak",
            "/w/html",
            "/w/.html",
            "/w/x.xhtml",
        ] {
            assert!(!is_html_document(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn a_relative_src_is_rewritten_against_the_documents_folder() {
        let html = r#"<p><img src="icon.png" alt="x"></p>"#;
        assert_eq!(
            rewrite_resources(html, "/w/docs", &serve),
            r#"<p><img src="/api/raw?path=%2Fw%2Fdocs%2Ficon.png" alt="x"></p>"#
        );
    }

    #[test]
    fn absolute_scheme_fragment_and_empty_values_are_left_alone() {
        let html = r##"<a href="/abs">a</a><a href="https://x/y">b</a><a href="#frag">c</a><a href="">d</a><img src="//cdn/x.png">"##;
        let rewritten = rewrite_resources(html, "/w", &serve);
        assert!(rewritten.contains(r#"href="/abs""#));
        assert!(rewritten.contains(r#"href="https://x/y""#));
        assert!(rewritten.contains(r##"href="#frag""##));
        assert!(rewritten.contains(r#"href="""#));
        assert!(rewritten.contains(r#"src="//cdn/x.png""#));
    }

    #[test]
    fn join_path_drops_dot_and_never_pops_the_root() {
        assert_eq!(join_path("/w/docs", "./a.png"), "/w/docs/a.png");
        assert_eq!(join_path("/w/docs", "../a.png"), "/w/a.png");
        assert_eq!(join_path("/w", "../../../a.png"), "/a.png");
        assert_eq!(join_path("/", "a.png"), "/a.png");
    }

    #[test]
    fn a_fragment_survives_the_rewrite() {
        assert_eq!(
            rewrite_resources(r#"<a href="page.html#top">x</a>"#, "/w", &serve),
            r#"<a href="/api/raw?path=%2Fw%2Fpage.html#top">x</a>"#
        );
    }

    #[test]
    fn a_srcset_has_every_candidate_rewritten() {
        let html = r#"<img srcset="a.png 1x, b.png 2x" src="a.png">"#;
        let rewritten = rewrite_resources(html, "/w", &serve);
        assert!(
            rewritten.contains(
                "srcset=\"/api/raw?path=%2Fw%2Fa.png 1x, /api/raw?path=%2Fw%2Fb.png 2x\""
            )
        );
    }

    #[test]
    fn the_attribute_name_is_case_insensitive_and_spacing_is_tolerated() {
        let html = r#"<img SRC = "a.png">"#;
        assert!(rewrite_resources(html, "/w", &serve).contains("/api/raw?path=%2Fw%2Fa.png"));
    }

    #[test]
    fn a_document_without_resources_is_unchanged() {
        let html = "<p>plain</p>";
        assert_eq!(rewrite_resources(html, "/w", &serve), html);
    }

    #[test]
    fn source_base_is_absent_from_the_response_before_browser_parsing() {
        let document = prepare_document(
            Path::new("/w/docs/index.html"),
            r#"<head><BaSe data-note="quoted > bracket" href="https://example.invalid/hostile/"><base href=//example.invalid/second/></head><body><link rel="stylesheet" href="theme.css"><img src="a.png"></body>"#,
            0,
        );
        assert_eq!(
            document.html,
            r#"<head></head><body><link rel="stylesheet" href="/api/raw?path=%2Fw%2Fdocs%2Ftheme.css"><img src="/api/raw?path=%2Fw%2Fdocs%2Fa.png"></body>"#
        );
        assert_eq!(document.csp, PREVIEW_CSP);
    }

    #[test]
    fn source_base_filter_preserves_non_tag_text() {
        let source = r#"<!-- <base target="comment >"> --><pre><code>&lt;base href=example&gt;</code></pre><script>const sample = "<base target=script>";</script><style>p::after { content: "<base target=style>" }</style><textarea><base target=textarea></textarea><title><base target=title></title><div title="<base target=attribute>">base text</div><baseball>unchanged</baseball>"#;
        assert_eq!(
            rewrite_resources(
                &format!("{source}<base href=\"https://example.invalid/\">"),
                "/w/docs",
                &serve
            ),
            source
        );
        assert_eq!(
            rewrite_resources(
                "İ雪<!--><base href=\"https://example.invalid/\"><!-- hidden <base> --!><noscript><base href=\"https://example.invalid/\"></noscript>",
                "/w/docs",
                &serve
            ),
            "İ雪<!--><!-- hidden <base> --!><noscript></noscript>"
        );
        assert_eq!(
            rewrite_resources(
                "<div title=\"a > <base>\">ok</div><base title=unquoted\" href=https://example.invalid/>end",
                "/w/docs",
                &serve
            ),
            "<div title=\"a > <base>\">ok</div>end"
        );
        for tag in [
            "<BASE>",
            "<base\nhref = 'https://example.invalid/a>b'>",
            "<base href=https://example.invalid/>",
            "<base/href=\"https://example.invalid/\">",
        ] {
            assert_eq!(
                rewrite_resources(&format!("before{tag}after"), "/w/docs", &serve),
                "beforeafter"
            );
        }
    }

    #[test]
    fn base_removal_cannot_splice_data_text_into_a_new_base_or_comment() {
        for (source, expected) in [
            (
                "<<base>base href=https://example.invalid/>x",
                "&lt;base href=https://example.invalid/>x",
            ),
            (
                "<<base>!-- hidden --><base href=https://example.invalid/>x",
                "&lt;!-- hidden -->x",
            ),
            (
                "<<base><base>base href=https://example.invalid/>x",
                "&lt;base href=https://example.invalid/>x",
            ),
            (
                "İ雪<<<base>base href=https://example.invalid/>x",
                "İ雪<&lt;base href=https://example.invalid/>x",
            ),
            (
                "<div title=\"<\">text</div><base>x",
                "<div title=\"<\">text</div>x",
            ),
            ("<!-- < --><base>x", "<!-- < -->x"),
            ("<textarea><</textarea><base>x", "<textarea><</textarea>x"),
        ] {
            assert_eq!(
                rewrite_resources(source, "/w/docs", &serve),
                expected,
                "{source}"
            );
        }
    }

    #[test]
    fn many_base_removals_protect_each_splice_with_bounded_output_growth() {
        let count = 4096;
        let source = "<<base><base>base href=https://example.invalid/>x".repeat(count);
        let expected = "&lt;base href=https://example.invalid/>x".repeat(count);
        let output = rewrite_resources(&source, "/w/docs", &serve);
        assert_eq!(output, expected);
        assert!(output.len() <= source.len() + 3 * count);
        assert_eq!(
            rewrite_resources(
                &format!(
                    "<{}base href=https://example.invalid/>x",
                    "<base>".repeat(count)
                ),
                "/w/docs",
                &serve,
            ),
            "&lt;base href=https://example.invalid/>x",
            "adjacent removals do not repeatedly escape a protected output boundary",
        );
    }

    #[test]
    fn source_base_filter_applies_inside_nested_markup() {
        assert_eq!(
            rewrite_resources(
                r#"<template><base href="https://example.invalid/"><p>template</p></template><svg><base href="https://example.invalid/"></base><text>svg</text></svg>"#,
                "/w/docs",
                &serve
            ),
            "<template><p>template</p></template><svg></base><text>svg</text></svg>"
        );
    }

    #[test]
    fn raw_route_encodes_like_encode_uri_component() {
        assert_eq!(
            raw_route("/w/docs/a b.png"),
            "/api/raw?path=%2Fw%2Fdocs%2Fa%20b.png"
        );
        assert_eq!(
            raw_route("/w/a~b!c(d).png"),
            "/api/raw?path=%2Fw%2Fa~b!c(d).png"
        );
    }

    #[test]
    fn base_none_policy_matches_the_shared_preview_without_an_injected_base() {
        let page = crate::page::PAGE_SOURCE;
        let start = page.find("async function showHtml(").unwrap();
        let end = page[start..].find("\n}").unwrap() + start;
        let show_html = &page[start..end];
        assert!(PREVIEW_CSP.contains("base-uri 'none'"));
        for directive in [
            "default-src 'none'",
            "script-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
        ] {
            assert!(PREVIEW_CSP.contains(directive));
        }
        assert!(!ALLOWED_TAGS.contains(&"base"));
        assert!(
            show_html.contains("'select', 'base'"),
            "source base is sanitized"
        );
        assert!(
            !show_html.contains("<base"),
            "the application must not contradict base-none"
        );
        assert!(show_html.contains("frame.setAttribute('sandbox', 'allow-same-origin')"));
        assert!(show_html.contains("frame.setAttribute('referrerpolicy', 'no-referrer')"));
        assert!(show_html.contains("frame.src = '/api/html/frame'"));
        assert!(show_html.contains("parseFromString(clean, 'text/html')"));
        assert!(show_html.contains("inner.documentElement.replaceWith(inner.importNode"));
        assert!(show_html.contains("ticket !== fileFetches || htmlView !== frame"));
        assert!(!show_html.contains(".srcdoc ="));
        assert!(!show_html.contains("body.csp"));
        assert_eq!(frame_policy(), format!("{PREVIEW_CSP}; frame-ancestors 'self'; sandbox allow-same-origin"));
    }

    #[test]
    fn relative_stylesheet_and_images_do_not_require_a_base() {
        let document = prepare_document(
            Path::new("/w/docs/index.html"),
            r#"<link rel="stylesheet" href="theme.css"><img src="a.png"><style>@import "nested.css"; p { background: url(bg.png) }</style>"#,
            0,
        );
        assert!(
            document
                .html
                .contains(r#"href="/api/raw?path=%2Fw%2Fdocs%2Ftheme.css""#)
        );
        assert!(
            document
                .html
                .contains(r#"src="/api/raw?path=%2Fw%2Fdocs%2Fa.png""#)
        );
        // Full CSS dependency rewriting remains outside this preview contract.
        assert!(document.html.contains(r#"@import "nested.css""#));
        assert!(document.html.contains("url(bg.png)"));
    }

    #[test]
    fn prepare_document_carries_the_policy_and_the_rewrite() {
        let document =
            prepare_document(Path::new("/w/docs/index.html"), r#"<img src="a.png">"#, 17);
        assert_eq!(document.path, "/w/docs/index.html");
        assert_eq!(document.csp, PREVIEW_CSP);
        assert_eq!(document.bytes, 17);
        assert_eq!(
            document.html,
            r#"<img src="/api/raw?path=%2Fw%2Fdocs%2Fa.png">"#
        );
    }

    #[test]
    fn highlight_modules_are_served_wrapped_and_only_from_the_list() {
        let root = std::env::temp_dir().join(format!("heddle-hljs-{}", std::process::id()));
        let package = root.join("node_modules/highlight.js");
        std::fs::create_dir_all(package.join("lib")).unwrap();
        std::fs::create_dir_all(package.join("es/languages")).unwrap();
        std::fs::write(
            package.join("lib/core.js"),
            "module.exports = { core: true };",
        )
        .unwrap();
        std::fs::write(
            package.join("es/languages/rust.js"),
            "export default function rust() {}",
        )
        .unwrap();
        std::fs::write(
            package.join("es/languages/haskell.js"),
            "export default function haskell() {}",
        )
        .unwrap();
        let roots = vec![PathBuf::from("/nowhere"), root.clone()];
        assert_eq!(
            highlight_asset(&roots, "core.js").as_deref(),
            Some(
                "const module = { exports: {} };\nconst exports = module.exports;\nmodule.exports = { core: true };\nexport default module.exports;\n"
            )
        );
        assert_eq!(
            highlight_asset(&roots, "languages/rust.js").as_deref(),
            Some("export default function rust() {}")
        );
        assert_eq!(
            highlight_asset(&roots, "languages/haskell.js"),
            None,
            "a grammar the server does not register is not served"
        );
        assert_eq!(
            highlight_asset(&roots, "languages/../lib/core.js"),
            None,
            "nor any other file"
        );
        assert_eq!(highlight_asset(&roots, "lib/core.js"), None);
        assert_eq!(
            highlight_asset(&[PathBuf::from("/nowhere")], "core.js"),
            None,
            "no package, no module"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn purify_is_found_under_a_root_or_not_at_all() {
        let root = std::env::temp_dir().join(format!("heddle-purify-{}", std::process::id()));
        let nested = root.join("node_modules").join("dompurify").join("dist");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("purify.min.js"), "// purify").unwrap();
        assert_eq!(
            purify_path(std::slice::from_ref(&root)),
            Some(nested.join("purify.min.js"))
        );
        assert_eq!(purify_path(&[root.join("missing")]), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_embedded_sanitiser_is_dompurify_and_equals_the_installed_package() {
        assert!(
            EMBEDDED_PURIFY.starts_with("/*! @license DOMPurify "),
            "the embedded file is DOMPurify with its licence header"
        );
        // Where the repository has the package installed (every checkout that builds the TypeScript side), the copy
        // the binary carries must be the very file the TypeScript build serves.
        let installed = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(PURIFY_RELATIVE_PATH);
        if let Ok(text) = std::fs::read_to_string(&installed) {
            assert!(
                text == EMBEDDED_PURIFY,
                "rust/crates/heddle-server/assets/purify.min.js differs from {}: copy the installed file over it",
                installed.display()
            );
        }
    }
}
