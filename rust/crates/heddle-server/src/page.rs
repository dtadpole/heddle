//! The page, its build marker, the tab icon, and the token form a refused request gets.
//!
//! **One page serves both builds**: `src/server/page.html` is embedded at compile time, not rewritten, so
//! the binary carries the exact document the TypeScript server reads at runtime. The served copy carries
//! `<meta name="heddle-page" content="<first 12 hex of sha256(file)>">`, computed here rather than pasted,
//! so a stale deployment can be told apart from a missing feature (`_verifiers_/87-resizable-panels`
//! compares it with the hash of the file).

use sha2::{Digest, Sha256};

/// `src/server/page.html`, as committed. Edited only in the TypeScript tree; a rebuild picks it up.
pub const PAGE_SOURCE: &str = include_str!("../../../../src/server/page.html");

/// The project's own `heddle.svg`, served as the tab icon at `/favicon.svg` and `/favicon.ico` without a
/// token, as the TypeScript build serves it.
pub const FAVICON_SVG: &[u8] = include_bytes!("../../../../heddle.svg");

/// The title of the token form, which is not the app's title.
pub const TOKEN_FORM_TITLE: &str = "heddle web";

/// The first 12 hex characters of the SHA-256 of a document.
pub fn page_marker(html: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(html.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(12);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// The inline scripts of a page, as a browser ends them: each `<script>` without a `src`, up to the first `</script>`
/// (the TypeScript `inlineScripts`).
pub fn inline_scripts(html: &str) -> Vec<&str> {
    let lower = html.to_ascii_lowercase();
    let mut scripts = Vec::new();
    let mut from = 0usize;
    while let Some(offset) = lower[from..].find("<script") {
        let start = from + offset;
        let after = start + "<script".len();
        // `<script` must end its name here: `<scripts>` or `<scripting>` is another element.
        if !lower[after..].starts_with(|c: char| c == '>' || c.is_ascii_whitespace()) {
            from = after;
            continue;
        }
        let Some(tag_end) = lower[after..].find('>').map(|at| after + at + 1) else {
            break;
        };
        let Some(close) = closing_script(&lower, tag_end) else {
            break;
        };
        if !has_src_attribute(&lower[after..tag_end - 1]) {
            scripts.push(&html[tag_end..close.0]);
        }
        from = close.1;
    }
    scripts
}

/// The next `</script\s*>` at or after `from`: where it starts and where it ends.
fn closing_script(lower: &str, from: usize) -> Option<(usize, usize)> {
    let mut at = from;
    while let Some(offset) = lower[at..].find("</script") {
        let start = at + offset;
        let rest = &lower[start + "</script".len()..];
        let spaces = rest.len() - rest.trim_start().len();
        if rest[spaces..].starts_with('>') {
            return Some((start, start + "</script".len() + spaces + 1));
        }
        at = start + "</script".len();
    }
    None
}

/// Whether an opening tag's attributes name a `src` (`\bsrc\s*=`).
fn has_src_attribute(attributes: &str) -> bool {
    let bytes = attributes.as_bytes();
    let mut from = 0usize;
    while let Some(offset) = attributes[from..].find("src") {
        let at = from + offset;
        let bounded = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        let rest = attributes[at + 3..].trim_start();
        if bounded && rest.starts_with('=') {
            return true;
        }
        from = at + 3;
    }
    false
}

/// The page's Content-Security-Policy, sent with `page.html` only (the TypeScript `pagePolicy`, word for word).
///
/// Defence in depth behind the sanitizer (live issues developer-two-6 and -7), approved by the coordinator as option
/// (1): `script-src` is strict ('self' and the sha256 of each inline script of the page as served); images,
/// stylesheets, fonts and media may also come over `https:` only because the HTML preview is a `srcdoc` frame, which
/// inherits this policy, and a previewed document may load remote assets under its own policy (issue #50 would
/// serve the preview at its own URL and drop them).
pub fn page_policy(html: &str) -> String {
    page_policy_with_browser(html, false)
}

/// D-068: remote frames are allowed only for the explicitly enabled Browser surface.
pub fn page_policy_with_browser(html: &str, browser_enabled: bool) -> String {
    use base64::Engine as _;
    let mut script_src = String::from("script-src 'self'");
    for code in inline_scripts(html) {
        let digest = Sha256::digest(code.as_bytes());
        script_src.push_str(&format!(
            " 'sha256-{}'",
            base64::engine::general_purpose::STANDARD.encode(digest)
        ));
    }
    [
        "default-src 'self'",
        &script_src,
        "style-src 'self' 'unsafe-inline' https:",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: https:",
        "media-src 'self' https:",
        if browser_enabled { "frame-src http: https:" } else { "frame-src 'self'" },
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ]
    .join("; ")
}

/// The document with its build marker filled in: the first `<meta name="heddle-page" ...>` element is
/// replaced by one whose `content` is [`page_marker`] of the **unmarked** document. A document without
/// the element is returned unchanged.
pub fn marked_page(html: &str) -> String {
    const OPEN: &str = "<meta name=\"heddle-page\"";
    let Some(start) = html.find(OPEN) else {
        return html.to_owned();
    };
    let Some(offset) = html[start..].find('>') else {
        return html.to_owned();
    };
    let end = start + offset + 1;
    let marker = page_marker(html);
    let mut marked = String::with_capacity(html.len() + marker.len());
    marked.push_str(&html[..start]);
    marked.push_str(&format!("<meta name=\"heddle-page\" content=\"{marker}\">"));
    marked.push_str(&html[end..]);
    marked
}

/// The page as served: [`marked_page`] of [`PAGE_SOURCE`], computed once per process.
pub fn page() -> &'static str {
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| marked_page(PAGE_SOURCE))
}

/// The policy for [`page`], computed once from the page as served, like the page itself.
pub fn served_policy() -> &'static str {
    static POLICY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| page_policy(page()))
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
    if authorized {
        PageAccess {
            status: 200,
            stale: false,
        }
    } else {
        PageAccess {
            status: 401,
            stale: offered_cookie,
        }
    }
}

/// The page a refused request gets: the token form, and why it appeared.
///
/// Two refusals, told apart: `stale` says *"That token is not the current one."*, otherwise *"A launch
/// token is required for this page."*. Both carry `<form method="get" action="/">` with an input named
/// [`crate::token::TOKEN_QUERY`] and the line that reads the current token from `~/.heddle/web.log`. The
/// markup is byte-for-byte the TypeScript `tokenFormPage`.
pub fn token_form_page(stale: bool) -> String {
    let reason = if stale {
        "<p><strong>That token is not the current one.</strong> A launch token is minted once per start, so a URL from an earlier run — a bookmark, the history, or an old log line — stops working when the server restarts.</p>"
    } else {
        "<p><strong>A launch token is required for this page.</strong> heddle prints one URL per start, with the token in it, and only that token opens this page.</p>"
    };
    let how = "<p>Read the current one from the log, or paste it below:</p><pre>grep -o 'token=[A-Za-z0-9_-]*' ~/.heddle/web.log | tail -1</pre>";
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>heddle web</title>\
         <style>body{{margin:0;padding:2rem;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;color-scheme:light dark}}\
         h1{{font-size:1.1rem;margin:0 0 1rem}}pre{{background:color-mix(in oklab,currentColor 8%,transparent);padding:.6rem .8rem;border-radius:.35rem;overflow-x:auto}}\
         form{{display:flex;gap:.5rem;margin-top:1rem}}input{{flex:1;padding:.5rem;font:inherit}}button{{padding:.5rem 1rem;font:inherit}}</style>\
         </head><body><h1>heddle web</h1>{reason}{how}\
         <form method=\"get\" action=\"/\"><input name=\"{query}\" placeholder=\"token\" autofocus><button>open</button></form>\
         </body></html>",
        query = crate::token::TOKEN_QUERY
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_is_the_first_twelve_hex_of_the_digest() {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        assert_eq!(page_marker("abc"), "ba7816bf8f01");
        assert_eq!(page_marker("").len(), 12);
    }

    #[test]
    fn marked_page_fills_the_first_marker_and_leaves_the_rest() {
        let html = "<head><meta name=\"heddle-page\" content=\"STALE\"><meta name=\"other\" content=\"x\"></head>";
        let marked = marked_page(html);
        assert_eq!(
            marked,
            format!(
                "<head><meta name=\"heddle-page\" content=\"{}\"><meta name=\"other\" content=\"x\"></head>",
                page_marker(html)
            )
        );
        assert!(!marked.contains("STALE"));
    }

    #[test]
    fn marked_page_without_a_marker_is_unchanged() {
        assert_eq!(marked_page("<title>x</title>"), "<title>x</title>");
        assert_eq!(marked_page(""), "");
    }

    #[test]
    fn the_served_page_is_the_app_with_a_computed_marker() {
        let served = page();
        assert!(served.contains("<title>Heddle</title>"));
        assert!(served.contains("id=\"log\""));
        assert!(served.contains("/api/events"));
        assert!(served.contains(&format!(
            "<meta name=\"heddle-page\" content=\"{}\">",
            page_marker(PAGE_SOURCE)
        )));
        // Once per process: two calls are the same stored document.
        assert!(std::ptr::eq(page(), page()));
    }

    /// DSH's session rename (`dsh-client-ui-workspace`, `RenameSession.js`): one *Rename session* dialog, opened by
    /// the row menu, the `Mod+Alt+G` chord and a double-click on the row's title. The page is embedded, so this
    /// asserts the binary serves that dialog and the double-click that opens it, not a native `window.prompt`.
    #[test]
    fn the_served_page_renames_a_session_in_dshs_dialog_and_on_a_title_double_click() {
        let served = page();
        assert!(served.contains(
            "<dialog id=\"session-rename\" class=\"ws-dialog\" aria-labelledby=\"session-rename-title\">"
        ));
        assert!(served.contains("<h2 id=\"session-rename-title\">Rename session</h2>"));
        assert!(served.contains("id=\"session-rename-input\" aria-label=\"Session name\""));
        assert!(served.contains("label.addEventListener('dblclick', (event) => {"));
        assert!(!served.contains("window.prompt('Rename this session'"));
    }

    #[test]
    fn page_access_tells_missing_from_stale() {
        assert_eq!(
            page_access(true, false),
            PageAccess {
                status: 200,
                stale: false
            }
        );
        assert_eq!(
            page_access(false, false),
            PageAccess {
                status: 401,
                stale: false
            }
        );
        assert_eq!(
            page_access(false, true),
            PageAccess {
                status: 401,
                stale: true
            }
        );
    }

    /// DSH parity C13 (R-developer-eight-17): `In one list` takes the workspace tree's order, the newest pin first and
    /// then the last write, through `WorkspaceTree.flatList`, as DSH fronts a new pin in the group and in the flat list
    /// alike (`dsh-client-ui-workspace` `pinSessionOrder`). The page is embedded, so this asserts the binary serves that
    /// rule and no longer the creation-time sort that put the earlier of two pins first.
    #[test]
    fn the_served_flat_list_orders_sessions_by_the_trees_rule() {
        let served = page();
        assert!(served.contains("function flatList(sessions, options = {}) {"));
        assert!(served.contains(
            "const visible = WorkspaceTree.flatList(index.sessions, { archived: archiveMode })"
        ));
        assert!(!served.contains("String(right.created).localeCompare(String(left.created))"));
    }

    #[test]
    fn the_token_form_is_the_recoverable_refusal() {
        let missing = token_form_page(false);
        assert!(missing.contains("A launch token is required for this page."));
        assert!(missing.contains("<form method=\"get\" action=\"/\">"));
        assert!(missing.contains("name=\"token\""));
        assert!(missing.contains("~/.heddle/web.log"));

        let stale = token_form_page(true);
        assert!(stale.contains("That token is not the current one."));
        assert!(stale.contains("A launch token is minted once per start"));
        assert!(stale.contains("<form method=\"get\" action=\"/\">"));

        // Neither is the app shell, which is the point of the refusal.
        assert!(!missing.contains("id=\"log\""));
        assert!(!stale.contains("id=\"log\""));
    }

    #[test]
    fn the_favicon_is_the_projects_own_asset() {
        assert!(FAVICON_SVG.starts_with(b"<svg") || FAVICON_SVG.starts_with(b"<?xml"));
        assert!(!FAVICON_SVG.is_empty());
    }

    #[test]
    fn the_page_policy_carries_a_hash_for_every_inline_script_and_nothing_inline_beyond_them() {
        use base64::Engine as _;
        let html = page();
        let scripts = inline_scripts(html);
        assert_eq!(
            scripts.len(),
            2,
            "the page has a module script and a plain one"
        );
        let policy = served_policy();
        for code in &scripts {
            let hash =
                base64::engine::general_purpose::STANDARD.encode(Sha256::digest(code.as_bytes()));
            assert!(
                policy.contains(&format!("'sha256-{hash}'")),
                "every inline script is allowed by its hash"
            );
        }
        assert!(
            policy.starts_with("default-src 'self'; script-src 'self' 'sha256-"),
            "{policy}"
        );
        assert!(
            !policy.contains("unsafe-eval")
                && !policy.contains("script-src 'self' 'unsafe-inline'"),
            "{policy}"
        );
        assert!(
            policy.ends_with(
                "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
            ),
            "{policy}"
        );
    }

    #[test]
    fn a_script_with_a_src_is_not_an_inline_script() {
        let html = "<script src=\"/vendor/x.js\"></script><script type=\"module\">a()</script><scripts>no</scripts><SCRIPT>b()</SCRIPT >";
        assert_eq!(inline_scripts(html), vec!["a()", "b()"]);
    }
}


#[cfg(test)]
mod browser_policy_tests {
    use super::*;
    #[test]
    fn only_browser_capability_changes_the_frame_directive() {
        let strict = page_policy("<script>const x = 1</script>");
        let enabled = page_policy_with_browser("<script>const x = 1</script>", true);
        assert!(strict.contains("frame-src 'self'"));
        assert_eq!(enabled, strict.replace("frame-src 'self'", "frame-src http: https:"));
        assert!(enabled.contains("object-src 'none'") && enabled.contains("frame-ancestors 'none'"));
    }
}
