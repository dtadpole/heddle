//! A refused send in the page this binary serves is DSH's composer Toast, not a permanent line in the conversation.
//!
//! The binary embeds `src/server/page.html` (`page::PAGE_SOURCE`), so a refusal the Rust server answers is shown by the
//! code written there. DSH's composer (`dsh-client-ui-conversation`) shows a refused prompt as a Toast anchored above the
//! composer card: its own sentence for `session/writer-held`, `<message> (<code>)` otherwise (DSH parity
//! R-developer-seven-1, row S27). The wording is executed by `test/page-send-toast.test.ts` and the behaviour judged in
//! a browser by `_verifiers_/80-web-ui/check-send-toast.mjs`; this test is the removal detector on the build that embeds
//! the page.

use heddle_server::page::PAGE_SOURCE;

#[test]
fn a_refused_send_is_an_anchored_toast_in_dsh_words() {
    assert!(PAGE_SOURCE.contains("function turnRefusal(detail, status)"));
    assert!(
        PAGE_SOURCE.contains(
            "if (error && error.code === 'session/writer-held') return SESSION_IN_USE_TEXT"
        )
    );
    assert!(PAGE_SOURCE.contains("function showSessionToast(notice, anchor = null)"));
    assert_eq!(
        PAGE_SOURCE
            .matches("\n      showSendRefusal(error)\n")
            .count()
            + PAGE_SOURCE
                .matches("\n        showSendRefusal(error)\n")
                .count(),
        2,
        "the direct send and the queue both show the Toast"
    );
    assert!(
        !PAGE_SOURCE.contains("add('denied', `the message could not be sent"),
        "no permanent denied line is written for a refused send"
    );
}
