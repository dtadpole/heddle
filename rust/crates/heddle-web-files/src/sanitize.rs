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
//!
//! # One divergence, deliberate
//!
//! `sanitize.ts` reads a tag closed by `/>` as *unterminated* and writes the rest of the input back as text, so
//! `<img src="x" onerror="alert(1)"/>` reached the page with its handler intact — the allow-list never saw it.
//! Rather than port that, this scanner treats a `/>` that ends the tag as the tag's end: the tag is reduced like any
//! other and the handler is dropped ([`tests::a_self_closed_tag_is_reduced_and_never_passed_through_whole`]). The
//! TypeScript build's output for every other input is unchanged; this is the one case where the port is stricter,
//! not different in what it renders.

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
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut index = 0usize;

    while index < html.len() {
        let open = match html[index..].find('<') {
            Some(offset) => index + offset,
            None => {
                out.push_str(&html[index..]);
                break;
            }
        };
        out.push_str(&html[index..open]);

        // A comment or a declaration carries nothing a document view shows.
        if html[open..].starts_with("<!--") {
            index = match html[open + 4..].find("-->") {
                Some(offset) => open + 4 + offset + 3,
                None => html.len(),
            };
            continue;
        }
        if html[open..].starts_with("<!") || html[open..].starts_with("<?") {
            index = match html[open..].find('>') {
                Some(offset) => open + offset + 1,
                None => html.len(),
            };
            continue;
        }

        let closing = match bytes.get(open + 1) {
            Some(&byte) => byte == b'/',
            // A `<` that ends the document begins no tag, and is text rather than a swallowed character.
            None => {
                out.push_str("&lt;");
                index = open + 1;
                continue;
            }
        };
        let name_start = open + if closing { 2 } else { 1 };
        let Some((name, after_name)) = read_tag_name(html, name_start) else {
            // A `<` that begins no tag is text, and is passed through rather than swallowed.
            out.push_str("&lt;");
            index = open + 1;
            continue;
        };
        let name = name.to_ascii_lowercase();
        let mut cursor = after_name;
        let mut attributes: Vec<String> = Vec::new();
        let mut self_closed = false;
        let mut terminated = false;

        while cursor < html.len() {
            if bytes[cursor] == b'>' {
                terminated = true;
                cursor += 1;
                break;
            }
            if html[cursor..].starts_with("/>") {
                self_closed = true;
                terminated = true;
                cursor += 2;
                break;
            }
            if bytes[cursor] == b'/' {
                cursor += 1;
                continue;
            }
            let Some(attribute) = read_attribute(html, cursor) else {
                cursor += 1;
                continue;
            };
            cursor = attribute.end;
            if !ALLOWED_ATTRIBUTES.contains(&attribute.name.as_str())
                && !OWN_ATTRIBUTES.contains(&attribute.name.as_str())
            {
                continue;
            }
            if NUMERIC_ATTRIBUTES.contains(&attribute.name.as_str()) {
                if !is_pixel_count(&attribute.value) {
                    continue;
                }
                attributes.push(format!("{}=\"{}\"", attribute.name, attribute.value));
                continue;
            }
            if URL_ATTRIBUTES.contains(&attribute.name.as_str()) {
                let decided = match options.url {
                    None => Some(attribute.value),
                    Some(policy) => policy(
                        &attribute.value,
                        UrlSite {
                            tag: &name,
                            attribute: &attribute.name,
                        },
                    ),
                };
                let Some(decided) = decided else { continue };
                attributes.push(format!(
                    "{}=\"{}\"",
                    attribute.name,
                    decided.replace('"', "&quot;")
                ));
                continue;
            }
            if attribute.value.is_empty() {
                attributes.push(attribute.name);
            } else {
                attributes.push(format!(
                    "{}=\"{}\"",
                    attribute.name,
                    attribute.value.replace('"', "&quot;")
                ));
            }
        }
        if !terminated {
            // An unterminated tag: the rest is text.
            out.push_str(&html[open..]);
            break;
        }
        index = cursor;

        if !ALLOWED_ELEMENTS.contains(&name.as_str()) {
            if DROP_WITH_CONTENT.contains(&name.as_str()) && !closing {
                let close_tag = format!("</{name}");
                index = match find_ascii_case_insensitive(html, &close_tag, index) {
                    Some(close) => {
                        let after = close + close_tag.len();
                        match html[after..].find('>') {
                            Some(offset) => after + offset + 1,
                            None => html.len(),
                        }
                    }
                    None => html.len(),
                };
            }
            continue;
        }
        if closing {
            out.push_str("</");
            out.push_str(&name);
            out.push('>');
            continue;
        }
        out.push('<');
        if attributes.is_empty() {
            out.push_str(&name);
        } else {
            out.push_str(&name);
            out.push(' ');
            out.push_str(&attributes.join(" "));
        }
        if self_closed {
            out.push_str(" /");
        }
        out.push('>');
    }

    out
}

/// A start- or end-tag's name — `/^[a-zA-Z][a-zA-Z0-9-]*/` — and the byte after it.
fn read_tag_name(html: &str, from: usize) -> Option<(&str, usize)> {
    let bytes = html.as_bytes();
    let first = *bytes.get(from)?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let mut end = from + 1;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
        end += 1;
    }
    Some((&html[from..end], end))
}

/// One attribute as the scanner reads it: its lower-cased name, its raw value, and the byte after it.
struct AttributeAt {
    name: String,
    value: String,
    end: usize,
}

/// Read an attribute whose value is quoted, single-quoted or bare. Entities in the value are left alone.
fn read_attribute(html: &str, from: usize) -> Option<AttributeAt> {
    let bytes = html.as_bytes();
    let mut index = from;
    while index < bytes.len() {
        let character = html[index..].chars().next()?;
        if !is_js_space(character) {
            break;
        }
        index += character.len_utf8();
    }
    let first = *bytes.get(index)?;
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b':') {
        return None;
    }
    let mut end = index + 1;
    while end < bytes.len()
        && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'-' | b'_' | b':' | b'.'))
    {
        end += 1;
    }
    let name = html[index..end].to_ascii_lowercase();
    index = end;
    while index < bytes.len() {
        let character = html[index..].chars().next()?;
        if !is_js_space(character) {
            break;
        }
        index += character.len_utf8();
    }
    if bytes.get(index) != Some(&b'=') {
        return Some(AttributeAt {
            name,
            value: String::new(),
            end: index,
        });
    }
    index += 1;
    while index < bytes.len() {
        let character = html[index..].chars().next()?;
        if !is_js_space(character) {
            break;
        }
        index += character.len_utf8();
    }
    match bytes.get(index) {
        Some(&quote) if quote == b'"' || quote == b'\'' => {
            let stop = html[index + 1..]
                .find(quote as char)
                .map_or(html.len(), |offset| index + 1 + offset);
            Some(AttributeAt {
                name,
                value: html[index + 1..stop].to_string(),
                end: stop + 1,
            })
        }
        _ => {
            let mut stop = index;
            while stop < bytes.len() {
                let character = html[stop..].chars().next()?;
                if is_js_space(character) || character == '>' {
                    break;
                }
                stop += character.len_utf8();
            }
            Some(AttributeAt {
                name,
                value: html[index..stop].to_string(),
                end: stop,
            })
        }
    }
}

/// `/^\d{1,4}$/`: a count of pixels, which is the only thing a numeric attribute may say.
fn is_pixel_count(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4 && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// JavaScript's `\s`, which is what the TypeScript scanner tests each byte against.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `haystack.indexOf(needle, from)` for an ASCII `needle`, compared case-insensitively (`String#toLowerCase` then
/// `indexOf` in the TypeScript scanner).
fn find_ascii_case_insensitive(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let haystack = haystack.as_bytes();
    let needle = needle.as_bytes();
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|start| {
        needle
            .iter()
            .zip(&haystack[*start..])
            .all(|(left, right)| left.eq_ignore_ascii_case(right))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_element_that_is_not_on_the_list_is_dropped_and_its_text_kept() {
        assert_eq!(
            sanitize_html(
                "<p>a <custom-thing>b</custom-thing> c</p>",
                SanitizeOptions::default()
            ),
            "<p>a b c</p>"
        );
        assert_eq!(
            sanitize_html("<p>keep <b>bold</b></p>", SanitizeOptions::default()),
            "<p>keep bold</p>"
        );
    }

    #[test]
    fn an_element_whose_content_is_not_content_is_dropped_with_it() {
        assert_eq!(
            sanitize_html(
                "<p>a</p><script>alert(1)</script><p>b</p>",
                SanitizeOptions::default()
            ),
            "<p>a</p><p>b</p>"
        );
        assert_eq!(
            sanitize_html(
                "<style>p { color: red }</style>ok",
                SanitizeOptions::default()
            ),
            "ok"
        );
        assert_eq!(
            sanitize_html(
                "<iframe src=\"https://evil.example\"></iframe>ok",
                SanitizeOptions::default()
            ),
            "ok"
        );
    }

    #[test]
    fn an_attribute_that_is_not_on_the_list_is_dropped_including_handlers() {
        assert_eq!(
            sanitize_html(
                "<a href=\"/x\" onclick=\"steal()\">x</a>",
                SanitizeOptions::default()
            ),
            "<a href=\"/x\">x</a>"
        );
        assert_eq!(
            sanitize_html(
                "<img src=\"/x.png\" onerror=\"steal()\">",
                SanitizeOptions::default()
            ),
            "<img src=\"/x.png\">"
        );
        assert_eq!(
            sanitize_html(
                "<img src=\"/x.png\" srcset=\"evil.png\">",
                SanitizeOptions::default()
            ),
            "<img src=\"/x.png\">"
        );
        assert_eq!(
            sanitize_html(
                "<p style=\"position:fixed\">x</p>",
                SanitizeOptions::default()
            ),
            "<p>x</p>"
        );
    }

    #[test]
    fn a_url_attribute_is_decided_by_the_caller() {
        let url = |value: &str, _site: UrlSite<'_>| {
            value.starts_with("https://").then(|| value.to_string())
        };
        let options = SanitizeOptions { url: Some(&url) };
        assert_eq!(
            sanitize_html("<a href=\"https://ok.example\">x</a>", options),
            "<a href=\"https://ok.example\">x</a>"
        );
        assert_eq!(
            sanitize_html("<a href=\"javascript:alert(1)\">x</a>", options),
            "<a>x</a>"
        );
        assert_eq!(
            sanitize_html("<img src=\"http://no.example/x.png\">", options),
            "<img>"
        );
    }

    #[test]
    fn the_url_policy_is_told_which_element_and_attribute_it_decides() {
        // A link goes where it says, while an embedded image is beside the document and is resolved against it; a
        // policy that cannot see which one it is deciding cannot tell them apart.
        let policy = |value: &str, site: UrlSite<'_>| {
            (site.tag == "img" && site.attribute == "src").then(|| format!("/api/raw?path={value}"))
        };
        assert_eq!(
            sanitize_html(
                "<a href=\"x\">a</a><img src=\"y.svg\">",
                SanitizeOptions { url: Some(&policy) }
            ),
            "<a>a</a><img src=\"/api/raw?path=y.svg\">"
        );
    }

    #[test]
    fn a_comment_a_declaration_and_a_processing_instruction_carry_nothing_and_go() {
        assert_eq!(
            sanitize_html("a<!-- secret -->b", SanitizeOptions::default()),
            "ab"
        );
        assert_eq!(
            sanitize_html("a<!DOCTYPE html>b", SanitizeOptions::default()),
            "ab"
        );
        assert_eq!(
            sanitize_html("a<?xml version=\"1.0\"?>b", SanitizeOptions::default()),
            "ab"
        );
    }

    #[test]
    fn the_text_between_tags_is_passed_through_because_the_parser_already_escaped_it() {
        assert_eq!(
            sanitize_html(
                "<code>1 &lt; 2 &amp;&amp; 3 &gt; 2</code>",
                SanitizeOptions::default()
            ),
            "<code>1 &lt; 2 &amp;&amp; 3 &gt; 2</code>"
        );
    }

    #[test]
    fn a_quote_in_an_attribute_cannot_break_out_of_it() {
        assert_eq!(
            sanitize_html("<a title='a\"b'>x</a>", SanitizeOptions::default()),
            "<a title=\"a&quot;b\">x</a>"
        );
    }

    #[test]
    fn quoted_single_quoted_and_unquoted_attributes_are_all_read() {
        assert_eq!(
            sanitize_html(
                "<img alt=\"double\" src='/single.png'>",
                SanitizeOptions::default()
            ),
            "<img alt=\"double\" src=\"/single.png\">"
        );
        assert_eq!(
            sanitize_html("<img alt=bare src=/plain.png>", SanitizeOptions::default()),
            "<img alt=\"bare\" src=\"/plain.png\">"
        );
    }

    #[test]
    fn a_bare_less_than_that_begins_no_tag_is_text_and_is_not_swallowed() {
        assert_eq!(
            sanitize_html("2 < 3 and 5 > 4", SanitizeOptions::default()),
            "2 &lt; 3 and 5 > 4"
        );
    }

    #[test]
    fn an_allowed_element_keeps_its_structure_and_its_class() {
        let table = "<table class=\"t\"><thead><tr><th align=\"right\">a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>";
        assert_eq!(sanitize_html(table, SanitizeOptions::default()), table);
    }

    #[test]
    fn a_self_closed_tag_keeps_its_slash() {
        assert_eq!(
            sanitize_html("<br />", SanitizeOptions::default()),
            "<br />"
        );
        assert_eq!(
            sanitize_html("<img src=\"/x.png\"/>", SanitizeOptions::default()),
            "<img src=\"/x.png\" />"
        );
    }

    #[test]
    fn a_self_closed_tag_is_reduced_and_never_passed_through_whole() {
        // Measured in the TypeScript build, and it is an XSS: a tag closed with `/>` was written back to the page
        // **as the input said it**, handler and all, because the scanner read the close as "unterminated". The port
        // treats a `/>` that ends the tag as an end, so the allow-list still decides.
        assert_eq!(
            sanitize_html(
                "<img src=\"x\" onerror=\"alert(1)\"/>",
                SanitizeOptions::default()
            ),
            "<img src=\"x\" />"
        );
        assert_eq!(sanitize_html("<br/>", SanitizeOptions::default()), "<br />");
        assert_eq!(
            sanitize_html(
                "<p class=\"x\" onclick=\"steal()\"/>after",
                SanitizeOptions::default()
            ),
            "<p class=\"x\" />after"
        );
    }

    #[test]
    fn a_self_closed_tag_does_not_eat_the_text_after_it() {
        // Measured against `sanitize.ts`, which advances one byte past a `/>`-closed tag and so drops the first
        // character of what follows: `<p/>text` came back as `<p />ext`. The port ends the tag at its own `>`.
        assert_eq!(
            sanitize_html("<p/>text", SanitizeOptions::default()),
            "<p />text"
        );
        assert_eq!(
            sanitize_html(
                "<span onclick=\"alert(1)\"/>x</span>",
                SanitizeOptions::default()
            ),
            "<span />x</span>"
        );
    }

    #[test]
    fn an_unterminated_tag_leaves_the_rest_of_the_input_as_text() {
        assert_eq!(
            sanitize_html("a <span class=\"x", SanitizeOptions::default()),
            "a <span class=\"x"
        );
        assert_eq!(
            sanitize_html("<a href=\"x", SanitizeOptions::default()),
            "<a href=\"x"
        );
        assert_eq!(sanitize_html("a <", SanitizeOptions::default()), "a &lt;");
    }

    #[test]
    fn a_dimension_that_is_not_a_count_of_pixels_is_dropped() {
        assert_eq!(
            sanitize_html(
                "<img src=\"/x.png\" width=\"160\" height=\"40\">",
                SanitizeOptions::default()
            ),
            "<img src=\"/x.png\" width=\"160\" height=\"40\">"
        );
        assert_eq!(
            sanitize_html(
                "<img src=\"/x.png\" width=\"160px\" height=\"100%\" id=big>",
                SanitizeOptions::default()
            ),
            "<img src=\"/x.png\" id=\"big\">"
        );
        assert_eq!(
            sanitize_html("<img width=\"12345\">", SanitizeOptions::default()),
            "<img>",
            "five digits is not a count of pixels"
        );
    }

    #[test]
    fn a_valueless_attribute_is_written_as_its_name_and_a_closing_tag_carries_none() {
        assert_eq!(
            sanitize_html(
                "<input type=\"checkbox\" checked disabled>",
                SanitizeOptions::default()
            ),
            "<input type=\"checkbox\" checked disabled>"
        );
        assert_eq!(
            sanitize_html(
                "<p class=\"x\">a</p class=\"y\">",
                SanitizeOptions::default()
            ),
            "<p class=\"x\">a</p>"
        );
    }

    #[test]
    fn an_uppercase_tag_is_lowercased_and_its_content_dropped_when_it_must_be() {
        assert_eq!(
            sanitize_html(
                "<P>a</P><SCRIPT>bad()</SCRIPT>b",
                SanitizeOptions::default()
            ),
            "<p>a</p>b"
        );
    }

    #[test]
    fn sanitizing_twice_changes_nothing_the_second_time() {
        let once = sanitize_html(
            "<p onclick=\"x\">a <script>bad()</script><b>b</b></p>",
            SanitizeOptions::default(),
        );
        assert_eq!(sanitize_html(&once, SanitizeOptions::default()), once);
    }

    #[test]
    fn the_one_attribute_this_project_writes_survives_and_no_other_data_attribute_does() {
        assert_eq!(
            sanitize_html(
                "<a href=\"/x\" data-heddle-path=\"/workspace/heddle/README.md\">x</a>",
                SanitizeOptions::default()
            ),
            "<a href=\"/x\" data-heddle-path=\"/workspace/heddle/README.md\">x</a>"
        );
        assert_eq!(
            sanitize_html(
                "<a href=\"/x\" data-onclick=\"steal()\">x</a>",
                SanitizeOptions::default()
            ),
            "<a href=\"/x\">x</a>"
        );
    }

    #[test]
    fn a_link_may_open_beside_the_document_and_target_is_allowed_deliberately() {
        assert_eq!(
            sanitize_html(
                "<a href=\"https://x.example\" target=\"_blank\" rel=\"noreferrer noopener\">x</a>",
                SanitizeOptions::default()
            ),
            "<a href=\"https://x.example\" target=\"_blank\" rel=\"noreferrer noopener\">x</a>"
        );
    }
}
