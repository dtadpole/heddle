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
    todo!("port rewriteResources from src/server/html.ts")
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
