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

/// Rewrite a document's relative resources to the route that serves them.
///
/// The quoted values of `src` and `href` attributes (a whitespace character, the name in any case,
/// optional spaces around `=`, then a single- or double-quoted value) and every candidate URL of a
/// `srcset` are rewritten; a value that is empty, has a scheme, or starts with `//`, `/` or `#` is left
/// alone. A relative value is joined to `base` without a filesystem (`.` dropped, `..` pops but never above
/// the root), its `#fragment` kept apart, and passed to `serve`.
pub fn rewrite_resources(html: &str, base: &str, serve: &dyn Fn(&str) -> String) -> String {
    todo!()
}

/// The address `/api/html` points a rewritten resource at: `/api/raw?path=<percent-encoded path>`, encoded
/// the way `encodeURIComponent` encodes.
pub fn raw_route(path: &str) -> String {
    todo!()
}

/// Where `/vendor/purify.js` is read from, first existing wins: each root in `roots` joined with
/// [`PURIFY_RELATIVE_PATH`]. The binary passes the repository it was built from and the working
/// directory; a build without the package answers `404 the sanitiser is not installed`.
pub fn purify_path(roots: &[PathBuf]) -> Option<PathBuf> {
    todo!()
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
    todo!()
}
