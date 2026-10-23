//! Previewing an HTML document as a page — the port of `src/server/html.ts`, **proposed** for this crate.
//!
//! `html.ts` is listed under `heddle-server` in the crate map, but its only callers are `GET /api/html` and its
//! tests, and the only verifier that judges it is `_verifiers_/88-file-preview` (the html check), which this crate is
//! accountable for. Owning the route and its two helpers here makes that verifier one seat's work. If the server's
//! owner keeps `html.ts`, this module and the `/api/html` route move there unchanged.
//!
//! The design has three load-bearing parts, and only the third is the server's:
//!
//! 1. the document is sanitised **in the browser**, by DOMPurify (served at `/vendor/purify.js` — a page asset, left
//!    with the server, which embeds `page.html`), with the allow-lists below;
//! 2. it is shown in an `iframe` with `sandbox="allow-same-origin"` and no `allow-scripts`, under [`PREVIEW_CSP`];
//! 3. the server rewrites the document's relative `src`, `href` and `srcset` to the route that serves bytes
//!    ([`rewrite_resources`]), so they resolve beside the document rather than at the server root.

/// The largest document `GET /api/html` reads: 4 MiB; larger is `413`.
pub const MAX_HTML_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;

/// The elements a preview may contain. Narrower than DOMPurify's default: a reading pane, not a page builder.
pub const ALLOWED_TAGS: &[&str] = &[
    "a",
    "abbr",
    "article",
    "aside",
    "b",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "main",
    "mark",
    "nav",
    "ol",
    "p",
    "picture",
    "pre",
    "q",
    "s",
    "samp",
    "section",
    "small",
    "source",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
    "wbr",
    "link",
    "style",
];

/// The attributes those elements may carry.
pub const ALLOWED_ATTRS: &[&str] = &[
    "abbr", "align", "alt", "class", "colspan", "dir", "height", "href", "hreflang", "id", "lang",
    "media", "name", "rel", "role", "sizes", "span", "src", "srcset", "start", "style", "summary",
    "title", "type", "valign", "width",
];

/// The resource-address pattern DOMPurify tests each URL against, as JavaScript regular-expression source (flag `i`).
pub const ALLOWED_URI: &str = r"^(?:https?:|\/|\.{1,2}\/|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))";

/// The policy a previewed document runs under, as the `csp` field of the `GET /api/html` answer.
pub const PREVIEW_CSP: &str = "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; media-src 'self' https:; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

/// Rewrite a document's relative resources to the route that serves them.
///
/// Every quoted `src=`/`href=` value (case-insensitive, after white space) and every `srcset=` candidate URL that is
/// relative — not empty, no scheme, not `//…`, `/…` or `#…` — is joined to `base` lexically (`.` dropped, `..`
/// popping but never above the root) and replaced by `serve(joined)`, its `#fragment` kept after it. Everything else
/// is left byte-for-byte as written.
pub fn rewrite_resources(html: &str, base: &str, serve: &dyn Fn(&str) -> String) -> String {
    // The candidates of a `srcset` are rewritten first, so the `src`/`href` passes only ever see whole URLs.
    let srcset = rewrite_attribute(html, "srcset", base, serve, true);
    let src = rewrite_attribute(&srcset, "src", base, serve, false);
    rewrite_attribute(&src, "href", base, serve, false)
}

/// Rewrite one attribute's values, quoted with `"` or `'`, wherever a browser would fetch them.
fn rewrite_attribute(
    html: &str,
    attribute: &str,
    base: &str,
    serve: &dyn Fn(&str) -> String,
    srcset: bool,
) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut index = 0usize;
    while index < bytes.len() {
        // The TypeScript pattern begins with white space, which is what keeps `data-src=` out of it.
        if !bytes[index].is_ascii_whitespace() {
            out.push_str(&html[index..index + 1]);
            index += 1;
            continue;
        }
        let Some((quote, value_start)) = attribute_here(html, index + 1, attribute) else {
            out.push_str(&html[index..index + 1]);
            index += 1;
            continue;
        };
        let Some(close) = html[value_start..].find(quote).map(|at| value_start + at) else {
            out.push_str(&html[index..]);
            break;
        };
        let value = &html[value_start..close];
        out.push_str(&html[index..value_start]);
        if srcset {
            out.push_str(&rewrite_srcset(value, base, serve));
        } else {
            out.push_str(&rewrite_url(value, base, serve));
        }
        out.push(quote);
        index = close + 1;
    }
    out
}

/// Whether `attribute` (case-insensitively) begins at `from` and is followed by `=`, and where its value begins.
fn attribute_here(html: &str, from: usize, attribute: &str) -> Option<(char, usize)> {
    let bytes = html.as_bytes();
    let end = from + attribute.len();
    if end > bytes.len() || !html[from..end].eq_ignore_ascii_case(attribute) {
        return None;
    }
    let mut cursor = end;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'=') {
        return None;
    }
    cursor += 1;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    match bytes.get(cursor) {
        Some(&quote) if quote == b'"' || quote == b'\'' => Some((quote as char, cursor + 1)),
        _ => None,
    }
}

/// One URL: resolved against the document when it is relative, left byte-for-byte when it is not.
fn rewrite_url(value: &str, base: &str, serve: &dyn Fn(&str) -> String) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return value.to_string();
    }
    if crate::markdown::scheme_of(trimmed).is_some()
        || trimmed.starts_with("//")
        || trimmed.starts_with('/')
        || trimmed.starts_with('#')
    {
        return value.to_string();
    }
    let (path, fragment) = match trimmed.split_once('#') {
        Some((path, fragment)) => (path, format!("#{fragment}")),
        None => (trimmed, String::new()),
    };
    format!("{}{fragment}", serve(&join_path(base, path)))
}

/// `srcset` is a comma-separated list of `url [descriptor]` candidates.
fn rewrite_srcset(value: &str, base: &str, serve: &dyn Fn(&str) -> String) -> String {
    let candidates: Vec<String> = value
        .split(',')
        .map(|candidate| {
            let mut parts = candidate.trim().split_whitespace();
            let url = parts.next().unwrap_or("");
            let rest: Vec<&str> = parts.collect();
            if rest.is_empty() {
                rewrite_url(url, base, serve)
            } else {
                format!("{} {}", rewrite_url(url, base, serve), rest.join(" "))
            }
        })
        .collect();
    candidates.join(", ")
}

/// Join a relative path to the folder of the document that referred to it, without a filesystem.
fn join_path(base: &str, relative: &str) -> String {
    let joined = format!("{base}/{relative}");
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" if parts.is_empty() => parts.push(""),
            "." => {}
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_forbids_script_framing_and_forms() {
        assert!(PREVIEW_CSP.contains("script-src 'none'"));
        assert!(PREVIEW_CSP.contains("frame-src 'none'"));
        assert!(PREVIEW_CSP.contains("form-action 'none'"));
        assert!(PREVIEW_CSP.starts_with("default-src 'none'"));
    }

    fn serve(path: &str) -> String {
        format!("/api/raw?path={}", crate::markdown::percent_encode(path))
    }

    #[test]
    fn a_relative_resource_is_resolved_beside_its_document_and_a_foreign_one_is_left_alone() {
        let html = rewrite_resources(
            "<img src=\"icon.png\"><img src=\"./a/icon.png\"><img src=\"../up.png\"><img src=\"https://x/y.png\"><img src=\"/abs.png\"><img src=\"data:image/png;base64,AA\">",
            "/Users/zhenc/heddle/docs",
            &serve,
        );
        assert!(
            html.contains("src=\"/api/raw?path=%2FUsers%2Fzhenc%2Fheddle%2Fdocs%2Ficon.png\""),
            "a sibling file: {html}"
        );
        assert!(
            html.contains("%2Fdocs%2Fa%2Ficon.png"),
            "a subfolder, with the dot removed: {html}"
        );
        assert!(
            html.contains("%2FUsers%2Fzhenc%2Fheddle%2Fup.png"),
            "a parent reference resolved: {html}"
        );
        assert!(
            html.contains("src=\"https://x/y.png\""),
            "a remote file is the author's choice: {html}"
        );
        assert!(
            html.contains("src=\"/abs.png\""),
            "an absolute address is already absolute: {html}"
        );
        assert!(
            html.contains("src=\"data:image/png;base64,AA\""),
            "a data URL is not a file to look for: {html}"
        );
    }

    #[test]
    fn every_attribute_a_browser_fetches_is_rewritten_and_a_fragment_is_not_a_filename() {
        let html = rewrite_resources(
            "<link rel=\"stylesheet\" href=\"s.css\"><a href=\"page.html#part\">x</a><img srcset=\"a.png 1x, b.png 2x\"><style>h1 { background: url(bg.png) }</style>",
            "/docs",
            &serve,
        );
        assert!(
            html.contains("href=\"/api/raw?path=%2Fdocs%2Fs.css\""),
            "a stylesheet: {html}"
        );
        assert!(
            html.contains("href=\"/api/raw?path=%2Fdocs%2Fpage.html#part\""),
            "a link keeps its fragment: {html}"
        );
        assert!(
            html.contains(
                "srcset=\"/api/raw?path=%2Fdocs%2Fa.png 1x, /api/raw?path=%2Fdocs%2Fb.png 2x\""
            ),
            "and a srcset keeps its descriptors: {html}"
        );
        // A `url()` inside a stylesheet is not an attribute, so the document's own `<base>` element resolves it.
        assert!(
            html.contains("url(bg.png)"),
            "a url() in CSS is left for the base element: {html}"
        );
    }

    #[test]
    fn a_single_quoted_value_and_an_uppercase_attribute_are_rewritten_too() {
        let html = rewrite_resources("<IMG SRC='a.png'>", "/docs", &serve);
        assert!(
            html.contains("SRC='/api/raw?path=%2Fdocs%2Fa.png'"),
            "the spelling is kept and the value rewritten: {html}"
        );
    }

    #[test]
    fn a_data_attribute_named_like_a_fetch_is_not_rewritten() {
        let html = rewrite_resources("<img data-src=\"a.png\" src=\"b.png\">", "/docs", &serve);
        assert!(
            html.contains("data-src=\"a.png\""),
            "data-src is not an attribute a browser fetches: {html}"
        );
        assert!(
            html.contains("src=\"/api/raw?path=%2Fdocs%2Fb.png\""),
            "{html}"
        );
    }

    #[test]
    fn join_path_normalises_and_never_climbs_above_the_root() {
        assert_eq!(join_path("/docs", "a/b.png"), "/docs/a/b.png");
        assert_eq!(join_path("/docs", "./a.png"), "/docs/a.png");
        assert_eq!(join_path("/docs/x", "../a.png"), "/docs/a.png");
        assert_eq!(join_path("/", "../../a.png"), "/a.png");
    }

    #[test]
    fn an_empty_value_is_left_exactly_as_written() {
        assert_eq!(
            rewrite_resources("<img src=\"\">", "/docs", &serve),
            "<img src=\"\">"
        );
        assert_eq!(
            rewrite_resources("<img src=\"  \">", "/docs", &serve),
            "<img src=\"  \">"
        );
    }

    #[test]
    fn the_allow_lists_refuse_what_can_act() {
        for tag in [
            "script", "iframe", "form", "input", "object", "embed", "button",
        ] {
            assert!(!ALLOWED_TAGS.contains(&tag), "{tag} is not allowed");
        }
        for attribute in ["onclick", "onerror", "action", "formaction"] {
            assert!(
                !ALLOWED_ATTRS.contains(&attribute),
                "{attribute} is not allowed"
            );
        }
        for tag in ["img", "style", "link", "table"] {
            assert!(ALLOWED_TAGS.contains(&tag), "{tag} is allowed");
        }
    }
}
