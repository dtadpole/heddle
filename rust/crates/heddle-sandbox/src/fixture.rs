//! A recorded approval question and its answers, for the Web UI checks.
//!
//! The permission and Web UI checks judge the approval card without having to arrange a live denial first, so the
//! question they compare against is recorded under [`../fixtures/`](../fixtures/README.md) and pinned here: the
//! files are read at compile time, and the tests below fail if this crate's own serialisation stops producing
//! them. There is no second contract — a running server must write these bytes, and a check compares.
//!
//! | Constant | File |
//! |---|---|
//! | [`QUESTION_JSON`] | `fixtures/approval-question.json`, the compact `ApprovalRequest` |
//! | [`STREAM_FRAME`] | `fixtures/approval-stream-frame.txt`, `event: approval` + `data: <json>` + a blank line |
//! | [`ANSWER_ALLOWED_ONCE`] | `fixtures/approval-answer-allowed-once.json`, `{"outcome":"allowed-once"}` |
//! | [`ANSWER_REJECTED`] | `fixtures/approval-answer-rejected.json`, `{"outcome":"rejected"}` |
//!
//! The recorded `id`, `session` and `at` belong to one run; a check that compares a live frame replaces those
//! three fields and nothing else. What is fixed is the event name, the two-line frame (with its blank line), the
//! field names, and the display-reason wording the card shows.

use crate::approvals::{Answer, ApprovalRequest};

/// The recorded question, compact, exactly as the wire carries it (its file's trailing newline excluded).
pub const QUESTION_JSON: &str = include_str!("../fixtures/approval-question.json");

/// The recorded SSE frame, byte for byte, including the blank line that ends it.
pub const STREAM_FRAME: &str = include_str!("../fixtures/approval-stream-frame.txt");

/// The recorded answer that grants exactly one call.
pub const ANSWER_ALLOWED_ONCE: &str = include_str!("../fixtures/approval-answer-allowed-once.json");

/// The recorded answer that refuses the call.
pub const ANSWER_REJECTED: &str = include_str!("../fixtures/approval-answer-rejected.json");

/// The recorded question's wire JSON, without the file's trailing newline.
pub fn question_json() -> &'static str {
    QUESTION_JSON.trim_end()
}

/// The recorded question, parsed with this crate's own `ApprovalRequest` rules.
pub fn question() -> ApprovalRequest {
    serde_json::from_str(question_json()).expect("the recorded approval question parses")
}

/// The frame a published question is written in: `event: approval` newline, `data: <json>`, a blank line.
///
/// This is the shape `src/server/page.html` listens for (`events.addEventListener('approval', …)`) and the one
/// [`STREAM_FRAME`] records. It cannot fail: every field of [`ApprovalRequest`] is a string or an option of one.
pub fn stream_frame(request: &ApprovalRequest) -> String {
    format!(
        "event: approval\ndata: {}\n\n",
        serde_json::to_string(request).expect("an approval request is serialisable")
    )
}

/// The outcome an answer body names, judged by this crate's own rule (`{"outcome":"allowed-once"}`, …).
pub fn recorded_answer(body: &str) -> Option<Answer> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    Answer::parse(value.get("outcome")?.as_str()?)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{
        ANSWER_ALLOWED_ONCE, ANSWER_REJECTED, QUESTION_JSON, STREAM_FRAME, question, question_json,
        recorded_answer, stream_frame,
    };
    use crate::approvals::{Answer, is_approval_id};

    #[test]
    fn the_recorded_question_is_the_wire_form_the_crate_writes() {
        assert_eq!(
            serde_json::to_string(&question()).expect("the question serialises"),
            question_json(),
            "the file and the serialiser agree byte for byte"
        );
        assert!(
            QUESTION_JSON.ends_with('\n'),
            "the file itself is a normal text file; only its newline is not wire data"
        );
        assert!(is_approval_id(&question().id));
    }

    #[test]
    fn the_recorded_frame_is_the_one_the_page_listens_for() {
        assert_eq!(stream_frame(&question()), STREAM_FRAME);
        assert!(
            STREAM_FRAME.starts_with("event: approval\ndata: "),
            "the event name is `approval`, which is the listener the page registers"
        );
        assert!(
            STREAM_FRAME.ends_with("\n\n") && !STREAM_FRAME.ends_with("\n\n\n"),
            "one blank line ends the frame, not two"
        );
        let data = STREAM_FRAME
            .lines()
            .nth(1)
            .and_then(|line| line.strip_prefix("data: "))
            .expect("the frame has one data line");
        let parsed: Value = serde_json::from_str(data).expect("the frame's data line is JSON");
        assert_eq!(
            parsed,
            serde_json::to_value(question()).expect("the question as JSON")
        );
    }

    #[test]
    fn the_recorded_question_has_the_typescript_field_names() {
        let value: Value = serde_json::from_str(question_json()).expect("the question is JSON");
        let object = value.as_object().expect("the question is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["at", "displayReason", "id", "reason", "session", "tool"],
            "camelCase only: the page reads displayReason, and a snake_case key is a silent empty card"
        );
        assert_eq!(object["tool"], "bash");
        assert!(
            object["session"].is_string(),
            "the recorded question belongs to a session, as a live one does"
        );
    }

    #[test]
    fn the_card_text_carries_the_mode_and_the_justification_verbatim() {
        let request = question();
        assert_eq!(
            request.display_reason,
            "Allow this command with danger-full-access permissions: the write target is outside the workspace and the task requires it",
            "the page draws displayReason ?? reason, so this is what a person reads"
        );
        assert_eq!(
            request.reason,
            "escalate sandbox to danger-full-access: the write target is outside the workspace and the task requires it",
            "the audit reason names the target mode and the same justification"
        );
        assert!(
            request.display_reason.contains("danger-full-access")
                && request.display_reason.contains("outside the workspace"),
            "the two facts the Web UI check matches on"
        );
    }

    #[test]
    fn the_recorded_identifiers_are_version_four_uuids() {
        let request = question();
        for (label, value) in [
            ("id", request.id.trim_start_matches("approval-")),
            (
                "session",
                request
                    .session
                    .as_deref()
                    .unwrap_or("")
                    .trim_start_matches("session-"),
            ),
        ] {
            let hex: String = value
                .chars()
                .filter(|character| *character != '-')
                .collect();
            assert_eq!(hex.len(), 32, "the {label} is a 32-hex-digit uuid");
            assert_eq!(hex.as_bytes()[12], b'4', "the {label}'s version nibble");
            assert!(
                matches!(hex.as_bytes()[16], b'8' | b'9' | b'a' | b'b'),
                "the {label}'s RFC 4122 variant nibble"
            );
        }
        assert_eq!(
            request.at, "2026-10-22T20:31:07.412Z",
            "`at` is ISO 8601 UTC with milliseconds, the shape the crate writes"
        );
    }

    #[test]
    fn the_recorded_answers_name_the_two_outcomes_the_page_sends() {
        assert_eq!(
            recorded_answer(ANSWER_ALLOWED_ONCE),
            Some(Answer::AllowedOnce),
            "Allow once posts this body"
        );
        assert_eq!(
            recorded_answer(ANSWER_REJECTED),
            Some(Answer::Rejected),
            "Reject posts this body"
        );
        assert_eq!(
            recorded_answer("{\"outcome\":\"unavailable\"}"),
            None,
            "only the service concludes that one"
        );
        assert_eq!(recorded_answer("{}"), None);
        assert_eq!(recorded_answer("not json"), None);
    }

    /// The fixture's real claim: the live ladder, asked the same question, produces the recorded bytes.
    ///
    /// The recorded file is not hand-written text that merely parses; this drives `approve_escalation` through a
    /// real `ApprovalService` with the recorded justification and then compares the frame the server would write
    /// with the recorded frame, normalising only the two fields that belong to a run (`id` and `at`).
    #[tokio::test]
    async fn the_live_escalation_produces_the_recorded_question_and_frame() {
        use std::sync::Arc;
        use std::time::Duration;

        use crate::approvals::{Answer, ApprovalService, ApprovalsConfig};
        use crate::escalation::{EscalationRequest, EscalationSubject, approve_escalation};
        use crate::mode::SandboxMode;

        let recorded = question();
        let asked_tool = recorded.tool.clone();
        let asked_session = recorded.session.clone();
        let service = Arc::new(ApprovalService::new(ApprovalsConfig::default()));
        let _guard = service.attach_answerer();
        let channel = Arc::clone(&service);
        let worker = tokio::spawn(async move {
            approve_escalation(
                EscalationRequest {
                    tool: asked_tool,
                    requested_mode: serde_json::json!("danger-full-access"),
                    effective_mode: SandboxMode::WorkspaceWrite,
                    justification:
                        "the write target is outside the workspace and the task requires it"
                            .to_owned(),
                    subject: EscalationSubject::Command,
                    session: asked_session,
                },
                &*channel,
                std::future::pending::<()>(),
            )
            .await
        });

        let live = loop {
            if let Some(published) = service.pending_requests().into_iter().next() {
                break published;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        };
        assert_eq!(live.tool, recorded.tool);
        assert_eq!(
            live.reason, recorded.reason,
            "the audit reason, byte for byte"
        );
        assert_eq!(
            live.display_reason, recorded.display_reason,
            "the card text, byte for byte"
        );
        assert_eq!(live.session, recorded.session);
        assert!(crate::approvals::is_approval_id(&live.id));

        let mut normalised = live.clone();
        normalised.id.clone_from(&recorded.id);
        normalised.at.clone_from(&recorded.at);
        assert_eq!(
            stream_frame(&normalised),
            STREAM_FRAME,
            "a live frame is the recorded frame with only its run's id and time substituted"
        );

        assert!(service.answer(&live.id, Answer::AllowedOnce));
        assert_eq!(
            worker.await.expect("the escalation task"),
            Ok(SandboxMode::DangerFullAccess),
            "and the recorded answer grants the one wider call"
        );
    }
}
