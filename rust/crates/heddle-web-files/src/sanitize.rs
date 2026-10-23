//! An allow-list over rendered HTML — the port of `src/server/sanitize.ts`.
//!
//! The markdown library parses a document, passes its raw HTML through and escapes text in its own places, so the
//! safety guarantee sits on the **output**: every element that is not one a document view shows is dropped (its text
//! kept), and every attribute that is not one of the few carrying meaning is dropped. An allow-list rather than a
//! deny-list, because a deny-list is a list of the attacks its author thought of — `onclick`, `onerror`, `srcset`,
//! `style` and whatever is invented next are refused by not being on the list.
//!
//! The scanner walks the string once and is **total**: text between tags passes through unchanged (the parser
//! already escaped it), a `<` that does not begin a tag becomes `&lt;`, comments and declarations vanish, and the
//! content of `script`, `style`, `iframe`, `object`, `embed`, `template` and `noscript` vanishes with the tag.

/// Elements a document view renders. Anything else is dropped, with its text kept.
pub(crate) const ALLOWED_ELEMENTS: &[&str] = &[
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "section",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

/// Attributes a document view uses; `target` and `rel` because a remote link opens beside the document.
pub(crate) const ALLOWED_ATTRIBUTES: &[&str] = &[
    "align", "alt", "checked", "class", "disabled", "height", "href", "id", "src", "title", "type",
    "width", "target", "rel",
];

/// Attributes that may only be a count of pixels: one to four digits survive, anything else is dropped.
pub(crate) const NUMERIC_ATTRIBUTES: &[&str] = &["height", "width"];

/// Elements whose text is not content: dropping the tag drops what is inside it.
pub(crate) const DROP_WITH_CONTENT: &[&str] = &[
    "script", "style", "iframe", "object", "embed", "template", "noscript",
];

/// Attributes that carry a URL, and are handed to [`SanitizeOptions::url`].
pub(crate) const URL_ATTRIBUTES: &[&str] = &["href", "src"];

/// The one attribute this project writes for its own use, listed by name rather than by its `data-` prefix.
pub(crate) const OWN_ATTRIBUTES: &[&str] = &["data-heddle-path"];

/// Where a URL attribute was found, so a policy can treat a link and an embedded image differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UrlSite<'a> {
    /// The element's name, lower-cased (`a`, `img`).
    pub tag: &'a str,
    /// The attribute's name, lower-cased (`href`, `src`).
    pub attribute: &'a str,
}

/// A URL policy: the value to write, or `None` to drop the attribute.
pub type UrlPolicy<'p> = &'p dyn Fn(&str, UrlSite<'_>) -> Option<String>;

/// How [`sanitize_html`] treats what it keeps.
#[derive(Clone, Copy, Default)]
pub struct SanitizeOptions<'p> {
    /// Decides each `href` and `src`. `None` keeps the value as written; the markdown renderer always passes one,
    /// which applies `safe_url` and resolves a document's relative references.
    pub url: Option<UrlPolicy<'p>>,
}

/// Reduce rendered HTML to the elements and attributes a document view uses.
///
/// Byte-for-byte the TypeScript scanner's decisions: attribute names are lower-cased, a kept attribute is written
/// `name="value"` with `"` in the value as `&quot;` (a valueless one as its bare name), a self-closed tag keeps its
/// ` /`, and an unterminated tag leaves the rest of the input as text.
pub fn sanitize_html(html: &str, options: SanitizeOptions<'_>) -> String {
    todo!("port sanitizeHtml from src/server/sanitize.ts")
}
