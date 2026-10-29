//! Session rows in the page this binary serves say when a session waits for a person and when it finished unseen.
//!
//! The binary embeds `src/server/page.html` (`page::PAGE_SOURCE`). DSH's rows show the warning dot and **Approval** while
//! an approval waits, the done dot for a finished turn nobody opened, the spinner while running, and nothing when idle
//! (`dsh-client-ui-workspace`, Pending interactions; `completionUnread` in `dsh-client-ui-session`). The page showed only
//! the spinner (DSH parity R-developer-seven-3). The rule is executed by `test/page-row-status.test.ts` and judged in a
//! browser by `_verifiers_/80-web-ui/check-row-status.mjs`; this test is the removal detector on the embedded page.

use heddle_server::page::PAGE_SOURCE;

#[test]
fn the_row_status_follows_dsh_order() {
    let start = PAGE_SOURCE
        .find("function sessionRowStatus(")
        .expect("the page has a sessionRowStatus function");
    let body = &PAGE_SOURCE[start..];
    let body = &body[..body.find("\n}\n").expect("the function ends")];
    let order = [
        "sets.pending.has(id)",
        "sets.running.has(id)",
        "sets.unread.has(id)",
    ];
    let positions: Vec<usize> = order
        .iter()
        .map(|needle| body.find(needle).unwrap_or_else(|| panic!("{needle} is checked")))
        .collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "pending, then running, then unread: {positions:?}"
    );
    assert!(body.contains("label: 'Waiting for approval', trailing: 'Approval'"));
    assert!(body.contains("state: 'done', label: 'Completed'"));
}

#[test]
fn the_page_keeps_the_waiting_and_unread_sets() {
    assert!(PAGE_SOURCE.contains("const pendingApprovalSessions = new Set()"));
    assert!(PAGE_SOURCE.contains("const completionUnread = new Set()"));
    assert!(
        PAGE_SOURCE.contains("if (runningSessions.has(payload.session)) noteSessionStopped(payload.session)"),
        "a turn that ends unseen becomes unread"
    );
    assert!(
        PAGE_SOURCE.contains("if (completionUnread.delete(id)) paintRunningMarks()"),
        "opening a session reads it"
    );
}

/// The tab follows the open session, as DSH's `DocumentTitle` (`dsh-client-ui-layout`) does: `<title> — Heddle`, or the
/// product name alone (DSH parity R-developer-seven-4). Executed by `test/page-document-title.test.ts`.
#[test]
fn the_tab_title_follows_the_open_session() {
    assert!(PAGE_SOURCE.contains("const PRODUCT_TITLE = 'Heddle'"));
    assert!(PAGE_SOURCE.contains(
        "document.title = title === undefined ? PRODUCT_TITLE : `${title} — ${PRODUCT_TITLE}`"
    ));
    assert!(
        PAGE_SOURCE.contains("if (Array.isArray(sessions)) titledSessions = sessions"),
        "the title is repainted from each list read, so a rename shows"
    );
}

/// A refused send is DSH's Toast: announced, gone by itself, DSH's sentence for `session/writer-held` (DSH parity
/// R-developer-seven-1). Executed by `test/page-send-toast.test.ts`.
#[test]
fn a_refused_send_is_an_announced_toast() {
    assert!(PAGE_SOURCE.contains("<div id=\"composer-toast\" role=\"alert\" hidden>"));
    assert!(PAGE_SOURCE.contains("error.code === 'session/writer-held'"));
    assert_eq!(PAGE_SOURCE.matches("showToast(sendRefusalText(error))").count(), 2);
    assert!(!PAGE_SOURCE.contains("the message could not be sent"));
}
