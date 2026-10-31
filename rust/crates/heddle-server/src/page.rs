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

/// The page with its `<html lang>` set to `lang` (issue #80); the marker stays the file's own.
pub fn with_language(page: &str, lang: &str) -> String {
    page.replacen("<html lang=\"en\">", &format!("<html lang=\"{lang}\">"), 1)
}

/// The page as served: [`marked_page`] of [`PAGE_SOURCE`], computed once per process.
pub fn page() -> &'static str {
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| marked_page(PAGE_SOURCE))
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

    /// DSH parity C13 (R-developer-eight-17) with C17 (#63): `In one list` takes the workspace tree's rule in the
    /// selected order, through `WorkspaceTree.flatRows` (the `arrange` and `rowsOf` a group uses), as DSH's `deriveFlat`
    /// partitions the flat account's order (`dsh-client-ui-workspace` lib/client.js:1146-1154, 3583-3584). Under Last
    /// updated pin time does not order it; under Manual a pin fronts it. The page is embedded, so this asserts the binary
    /// serves that rule: no creation-time sort (which put the earlier of two pins first) and no pin-time-only `flatList`.
    #[test]
    fn the_served_flat_list_orders_sessions_by_the_trees_rule() {
        let served = page();
        assert!(served.contains("function flatRows(sessions, options = {}) {"));
        assert!(served.contains(
            "const flat = WorkspaceTree.flatRows(index.sessions, { archived: archiveMode, order: orderState })"
        ));
        assert!(!served.contains("function flatList("));
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

    /// DSH parity C23 and C31 (R-developer-eight-26, -1), with the reload of C28 and C33 (-28, -2): the page this
    /// binary embeds keeps a subagent's child out of the flat list and the search as well as the tree
    /// (dsh-client-ui-workspace `sessionVisible`), reopens the saved session on a reload instead of `sessions[0]`
    /// (`restoreSelection`, the tree block's `restoreChoice`), and gives a one-shot child DSH's read-only record in
    /// place of the composer (dsh-client-ui-subagent `SubagentReadOnlyComposer`). The rules themselves are judged in
    /// `test/session-rules.test.ts` and `test/workspace-tree.test.ts`.
    #[test]
    fn the_served_page_hides_subagents_restores_the_selection_and_locks_one_shot() {
        let served = page();
        assert!(served.contains("sessions: SessionRules.sidebarSessions(sessions),"));
        assert!(served.contains("WorkspaceTree.restoreChoice(saved, workspaces, sessions)"));
        assert!(!served.contains("const select = sessions[0]?.id ?? null"));
        assert!(served.contains("const SELECTION_KEY = 'heddle.sessions.current'"));
        assert!(served.contains("<div id=\"subagent-readonly\" role=\"status\" hidden><strong>One-shot subagent record</strong><span>One-shot tasks do not accept follow-ups; review the full execution record here.</span></div>"));
    }

    #[test]
    fn the_favicon_is_the_projects_own_asset() {
        assert!(FAVICON_SVG.starts_with(b"<svg") || FAVICON_SVG.starts_with(b"<?xml"));
        assert!(!FAVICON_SVG.is_empty());
    }

    /// DSH's workspace browser does not open an archived session (`dsh-client-ui-workspace` lib/client.js:3532-3538,
    /// `guardedOpen`): the row says "Archived sessions cannot be opened. Unarchive it to view." and carries that
    /// sentence as its accessible description (:2279, :4934). The page is embedded, so this asserts the binary serves
    /// the guarded row (live-testing draft developer-six-7).
    #[test]
    fn the_served_page_does_not_open_an_archived_session_row() {
        let served = page();
        assert!(served.contains(
            "const ARCHIVED_NOT_OPENABLE = 'Archived sessions cannot be opened. Unarchive it to view.'"
        ));
        assert!(served.contains("return !(node?.kind === 'session' && node.archived === true)"));
        assert!(served.contains(
            "if (!WorkspaceTree.opensOnClick(node)) li.setAttribute('aria-description', WorkspaceTree.ARCHIVED_NOT_OPENABLE)"
        ));
        assert!(served.contains(
            "if (!WorkspaceTree.opensOnClick(node)) {\n        notifyArchivedNotOpenable()\n        return\n      }"
        ));
    }
}
