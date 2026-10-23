//! `GET /api/todo?session=<id>`, answered as a status and the exact body bytes.
//!
//! The TypeScript server writes a success as `JSON.stringify(value, null, 2)` plus a newline and an error as
//! compact `JSON.stringify({error})` plus a newline; [`HttpAnswer::body`] is those bytes, so the Rust server
//! only sets `content-type: application/json` and writes them.

use crate::service::TodoService;

/// A route's answer: the status and the body, always `application/json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpAnswer {
    /// The HTTP status.
    pub status: u16,
    /// The exact body.
    pub body: String,
}

/// Answer `GET /api/todo`.
///
/// `service` is `None` when the profile does not load the todo plugin → 503. `session` is the `session` query
/// parameter: absent or empty → 400 `a session is required`; no such session → 404 `no session <id>`;
/// otherwise 200 `{"session": id, "todo": view | null}` — `null` for "never written", which a client can tell
/// from "written empty".
pub fn get_todo(service: Option<&TodoService>, session: Option<&str>) -> HttpAnswer {
    let Some(service) = service else {
        return failure(503, "this profile does not load the todo plugin");
    };
    let Some(wanted) = session.filter(|value| !value.is_empty()) else {
        return failure(400, "a session is required");
    };
    let Some(handle) = service.log().open(wanted) else {
        return failure(404, &format!("no session {wanted}"));
    };
    match service.get(&handle) {
        Ok(todo) => HttpAnswer {
            status: 200,
            body: pretty(&serde_json::json!({ "session": handle, "todo": todo })),
        },
        Err(error) => failure(500, &error.to_string()),
    }
}

/// An error answer: compact `{"error": …}` plus a newline, as the TypeScript server writes it.
fn failure(status: u16, message: &str) -> HttpAnswer {
    let body = serde_json::to_string(&serde_json::json!({ "error": message }))
        .expect("an error message is plain data");
    HttpAnswer {
        status,
        body: format!("{body}\n"),
    }
}

/// A success answer: `JSON.stringify(value, null, 2)` plus a newline.
fn pretty(value: &serde_json::Value) -> String {
    let mut body = serde_json::to_string_pretty(value).expect("a todo answer is plain data");
    body.push('\n');
    body
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::test_support::fixture;

    fn error_of(answer: &HttpAnswer) -> Value {
        serde_json::from_str(answer.body.trim()).expect("an error body is JSON")
    }

    #[test]
    fn a_profile_without_the_plugin_answers_503() {
        let answer = get_todo(None, Some("s1"));
        assert_eq!(answer.status, 503);
        assert_eq!(
            answer.body,
            "{\"error\":\"this profile does not load the todo plugin\"}\n"
        );
    }

    #[test]
    fn a_missing_or_empty_session_answers_400() {
        let (_log, service) = fixture("s1");
        for session in [None, Some("")] {
            let answer = get_todo(Some(&service), session);
            assert_eq!(answer.status, 400);
            assert_eq!(error_of(&answer)["error"], "a session is required");
        }
    }

    #[test]
    fn an_unknown_session_answers_404_with_its_name() {
        let (_log, service) = fixture("s1");
        let answer = get_todo(Some(&service), Some("nope"));
        assert_eq!(answer.status, 404);
        assert_eq!(error_of(&answer)["error"], "no session nope");
    }

    #[test]
    fn a_session_that_never_wrote_a_list_answers_null_not_empty() {
        let (_log, service) = fixture("s1");
        let answer = get_todo(Some(&service), Some("s1"));
        assert_eq!(answer.status, 200);
        assert_eq!(
            answer.body,
            "{\n  \"session\": \"s1\",\n  \"todo\": null\n}\n"
        );
    }

    #[test]
    fn a_written_list_answers_the_view_and_a_cleared_one_answers_an_empty_view() {
        let (_log, service) = fixture("s1");
        service
            .write(
                "s1",
                &json!([{"content": "first", "status": "in_progress"}]),
            )
            .unwrap();
        let answer = get_todo(Some(&service), Some("s1"));
        assert_eq!(answer.status, 200);
        let parsed: Value = serde_json::from_str(&answer.body).unwrap();
        assert_eq!(parsed["session"], "s1");
        assert_eq!(parsed["todo"]["todos"][0]["content"], "first");
        assert_eq!(parsed["todo"]["counts"]["inProgress"], 1);
        assert_eq!(parsed["todo"]["updatedAt"], crate::test_support::FIXED_NOW);

        service.clear("s1").unwrap();
        let cleared = get_todo(Some(&service), Some("s1"));
        let parsed: Value = serde_json::from_str(&cleared.body).unwrap();
        assert_eq!(parsed["todo"]["todos"], json!([]));
    }

    #[test]
    fn a_malformed_log_answers_500_rather_than_a_guess() {
        let (log, service) = fixture("s1");
        log.append_raw(
            "s1",
            json!({"type": "todo/write", "version": 99, "todos": [], "updatedAt": "now"}),
        );
        let answer = get_todo(Some(&service), Some("s1"));
        assert_eq!(answer.status, 500);
        assert_eq!(
            error_of(&answer)["error"],
            "unsupported todo write version 99"
        );
    }
}
