//! The page, its build marker, the tab icon, and the token form a refused request gets.
//!
//! **One page serves both builds**: `src/server/page.html` is embedded at compile time, not rewritten, so
//! the binary carries the exact document the TypeScript server reads at runtime. The served copy carries
//! `<meta name="heddle-page" content="<first 12 hex of sha256(file)>">`, computed here rather than pasted,
//! so a stale deployment can be told apart from a missing feature (`_verifiers_/87-resizable-panels`
//! compares it with the hash of the file).

/// `src/server/page.html`, as committed. Edited only in the TypeScript tree; a rebuild picks it up.
pub const PAGE_SOURCE: &str = include_str!("../../../../src/server/page.html");

/// The project's own `heddle.svg`, served as the tab icon at `/favicon.svg` and `/favicon.ico` without a
/// token, as the TypeScript build serves it.
pub const FAVICON_SVG: &[u8] = include_bytes!("../../../../heddle.svg");

/// The title of the token form, which is not the app's title.
pub const TOKEN_FORM_TITLE: &str = "heddle web";

/// The first 12 hex characters of the SHA-256 of a document.
pub fn page_marker(html: &str) -> String {
    todo!()
}

/// The document with its build marker filled in: the first `<meta name="heddle-page" ...>` element is
/// replaced by one whose `content` is [`page_marker`] of the **unmarked** document. A document without
/// the element is returned unchanged.
pub fn marked_page(html: &str) -> String {
    todo!()
}

/// The page as served: [`marked_page`] of [`PAGE_SOURCE`], computed once per process.
pub fn page() -> &'static str {
    todo!()
}

/// What a request for the page is answered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageAccess {
    /// `200` with the page, or `401` with the token form.
    pub status: u16,
    /// Whether the form says the credential is stale (one was offered and refused) rather than missing.
    pub stale: bool,
}

/// The page needs a session: `200` when authorized; otherwise `401`, stale exactly when a cookie was
/// offered.
pub fn page_access(authorized: bool, offered_cookie: bool) -> PageAccess {
    todo!()
}

/// The page a refused request gets: the token form, and why it appeared.
///
/// Two refusals, told apart: `stale` says *"That token is not the current one."*, otherwise *"A launch
/// token is required for this page."*. Both carry `<form method="get" action="/">` with an input named
/// [`crate::token::TOKEN_QUERY`] and the line that reads the current token from `~/.heddle/web.log`. The
/// markup is byte-for-byte the TypeScript `tokenFormPage`.
pub fn token_form_page(stale: bool) -> String {
    todo!()
}
