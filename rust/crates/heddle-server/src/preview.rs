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
//!    (`/api/raw?path=…`), before the sanitiser sees them.
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

/// The policy a previewed document runs under, as a `meta` element inside it.
pub const PREVIEW_CSP: &str = "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; media-src 'self' https:; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

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

/// Where `/vendor/purify.js` is read from, first existing wins: each root in `roots` joined with
/// [`PURIFY_RELATIVE_PATH`]. The binary passes the repository it was built from and the working
/// directory; a build without the package answers `404 the sanitiser is not installed`.
pub fn purify_path(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join(PURIFY_RELATIVE_PATH))
        .find(|candidate| candidate.is_file())
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
}
