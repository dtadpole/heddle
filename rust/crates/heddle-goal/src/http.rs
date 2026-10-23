//! `GET /api/goal?session=<id>` and `POST /api/goal`, answered as a status and the exact body bytes.
//!
//! The POST is the **person's** side of the verbs, so it may resume a paused goal, which the model's tool may
//! not. Errors carry the service's code beside the sentence: `GOAL_NOT_FOUND` is 404, `GOAL_STALE_REVISION` is
//! 409, any other failure 400. A success body is `JSON.stringify(value, null, 2)` plus a newline, an error body
//! compact JSON plus a newline, as the TypeScript server writes them.

use serde::Serialize;
use serde_json::Value;

use crate::service::{
    CreateGoal, EditGoal, GoalError, GoalErrorCode, GoalRef, GoalService, GoalView,
};

/// A route's answer: the status and the body, always `application/json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpAnswer {
    /// The HTTP status.
    pub status: u16,
    /// The exact body.
    pub body: String,
}

/// Answer `GET /api/goal`: 503 without the plugin, 400 without a session, 404 for an unknown one, else 200
/// `{"session": id, "goal": view | null}`.
pub fn get_goal(goals: Option<&GoalService>, session: Option<&str>) -> HttpAnswer {
    let Some(goals) = goals else {
        return failure(503, "this profile does not load the goal plugin");
    };
    let Some(wanted) = session.filter(|value| !value.is_empty()) else {
        return failure(400, "a session is required");
    };
    let Some(handle) = goals.log().open(wanted) else {
        return failure(404, &format!("no session {wanted}"));
    };
    match goals.get(&handle) {
        Ok(goal) => success(&SessionGoal {
            session: &handle,
            goal: goal.as_ref(),
        }),
        Err(error) => failure(500, &error.to_string()),
    }
}

/// Answer `POST /api/goal` with the parsed body `{session, action, goal_id?, revision?, objective?,
/// max_goal_rounds?, blocked_reason?}`; `action` is `create`, `edit`, `pause`, `resume`, `complete`, `blocked`
/// or `clear`. 200 `{"goal": view}` (`{"cleared": ref}` for a clear); 404 `no session <id>`; 400 for an unknown
/// action; a refusal as `{"error": sentence, "code": code}` with its status.
pub fn post_goal(goals: Option<&GoalService>, body: &Value) -> HttpAnswer {
    let Some(goals) = goals else {
        return failure(503, "this profile does not load the goal plugin");
    };
    let wanted = body.get("session").and_then(Value::as_str).unwrap_or("");
    let Some(handle) = goals.log().open(wanted) else {
        return failure(404, &format!("no session {wanted}"));
    };
    let action = body.get("action").and_then(Value::as_str).unwrap_or("");
    let reference = GoalRef {
        id: body
            .get("goal_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        revision: body
            .get("revision")
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite() && number.fract() == 0.0 && *number >= 1.0)
            .map(|number| number as u64)
            .unwrap_or(0),
    };
    let named_objective = body
        .get("objective")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let named_cap = body.get("max_goal_rounds").and_then(Value::as_f64);
    let outcome = match action {
        "create" => goals
            .create(
                &handle,
                CreateGoal {
                    objective: named_objective.unwrap_or_default(),
                    max_goal_rounds: named_cap,
                },
            )
            .map(GoalAnswer::Goal),
        "edit" => goals
            .edit(
                &handle,
                &reference,
                EditGoal {
                    objective: named_objective,
                    max_goal_rounds: named_cap,
                },
            )
            .map(GoalAnswer::Goal),
        "pause" => goals.pause(&handle, &reference).map(GoalAnswer::Goal),
        "resume" => goals.resume(&handle, &reference).map(GoalAnswer::Goal),
        "complete" => goals.complete(&handle, &reference).map(GoalAnswer::Goal),
        "blocked" => goals
            .block(
                &handle,
                &reference,
                body.get("blocked_reason").unwrap_or(&Value::Null),
            )
            .map(GoalAnswer::Goal),
        "clear" => goals.clear(&handle, &reference).map(GoalAnswer::Cleared),
        other => {
            return failure(
                400,
                &format!(
                    "unknown goal action {}",
                    serde_json::to_string(other).expect("a string is plain data")
                ),
            );
        }
    };
    match outcome {
        Ok(GoalAnswer::Goal(view)) => success(&GoalBody { goal: &view }),
        Ok(GoalAnswer::Cleared(cleared)) => success(&ClearedBody { cleared: &cleared }),
        Err(error) => refusal(&error),
    }
}

/// A parsed POST outcome.
enum GoalAnswer {
    Goal(GoalView),
    Cleared(GoalRef),
}

/// The GET body: `{session, goal | null}` in the TypeScript key order.
#[derive(Serialize)]
struct SessionGoal<'a> {
    session: &'a str,
    goal: Option<&'a GoalView>,
}

/// A success body carrying the view.
#[derive(Serialize)]
struct GoalBody<'a> {
    goal: &'a GoalView,
}

/// A success body carrying the tombstone.
#[derive(Serialize)]
struct ClearedBody<'a> {
    cleared: &'a GoalRef,
}

/// An error body: the sentence and the stable code.
#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    code: &'a str,
}

/// A success answer: `JSON.stringify(value, null, 2)` plus a newline.
fn success(value: &impl Serialize) -> HttpAnswer {
    let mut body = serde_json::to_string_pretty(value).expect("a goal answer is plain data");
    body.push('\n');
    HttpAnswer { status: 200, body }
}

/// An error answer: compact `{"error", "code"}` plus a newline.
fn failure(status: u16, message: &str) -> HttpAnswer {
    let body = serde_json::to_string(&ErrorBody {
        error: message,
        code: "",
    })
    .expect("an error message is plain data");
    HttpAnswer {
        status,
        body: format!("{body}\n"),
    }
}

/// A service refusal, with the status its code names.
fn refusal(error: &GoalError) -> HttpAnswer {
    let code = error.code();
    let status = match code {
        Some(GoalErrorCode::NotFound) => 404,
        Some(GoalErrorCode::StaleRevision) => 409,
        _ => 400,
    };
    let body = serde_json::to_string(&ErrorBody {
        error: &error.to_string(),
        code: code.map(GoalErrorCode::as_str).unwrap_or(""),
    })
    .expect("an error message is plain data");
    HttpAnswer {
        status,
        body: format!("{body}\n"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::service::CreateGoal;
    use crate::test_support::fixture;

    fn body_of(answer: &HttpAnswer) -> Value {
        serde_json::from_str(answer.body.trim()).expect("an answer body is JSON")
    }

    #[test]
    fn get_answers_503_400_404_null_and_the_view() {
        let (_log, goals) = fixture("s1");
        let missing = get_goal(None, Some("s1"));
        assert_eq!(missing.status, 503);
        assert_eq!(
            body_of(&missing)["error"],
            "this profile does not load the goal plugin"
        );
        for session in [None, Some("")] {
            let answer = get_goal(Some(&goals), session);
            assert_eq!(answer.status, 400);
            assert_eq!(body_of(&answer)["error"], "a session is required");
        }
        let unknown = get_goal(Some(&goals), Some("nope"));
        assert_eq!(unknown.status, 404);
        assert_eq!(body_of(&unknown)["error"], "no session nope");

        let empty = get_goal(Some(&goals), Some("s1"));
        assert_eq!(empty.status, 200);
        assert_eq!(
            empty.body,
            "{\n  \"session\": \"s1\",\n  \"goal\": null\n}\n"
        );

        let view = goals
            .create(
                "s1",
                CreateGoal {
                    objective: "one".into(),
                    max_goal_rounds: Some(4.0),
                },
            )
            .unwrap();
        let written = get_goal(Some(&goals), Some("s1"));
        let parsed = body_of(&written);
        assert_eq!(parsed["goal"]["id"], view.goal.id);
        assert_eq!(parsed["goal"]["maxGoalRounds"], 4);
        assert_eq!(parsed["goal"]["activation"], "armed");
    }

    #[test]
    fn post_creates_pauses_and_reports_a_stale_revision() {
        let (_log, goals) = fixture("s1");
        let created = post_goal(
            Some(&goals),
            &json!({"session": "s1", "action": "create", "objective": "one", "max_goal_rounds": 4}),
        );
        assert_eq!(created.status, 200);
        let view = body_of(&created)["goal"].clone();

        let paused = post_goal(
            Some(&goals),
            &json!({
                "session": "s1",
                "action": "pause",
                "goal_id": view["id"],
                "revision": view["revision"]
            }),
        );
        assert_eq!(paused.status, 200);
        assert_eq!(body_of(&paused)["goal"]["phase"], "paused");

        let stale = post_goal(
            Some(&goals),
            &json!({
                "session": "s1",
                "action": "complete",
                "goal_id": view["id"],
                "revision": view["revision"]
            }),
        );
        assert_eq!(stale.status, 409);
        assert_eq!(body_of(&stale)["code"], "GOAL_STALE_REVISION");
    }

    #[test]
    fn post_clears_and_answers_the_tombstone() {
        let (_log, goals) = fixture("s1");
        let created = post_goal(
            Some(&goals),
            &json!({"session": "s1", "action": "create", "objective": "one"}),
        );
        let view = body_of(&created)["goal"].clone();
        let cleared = post_goal(
            Some(&goals),
            &json!({
                "session": "s1",
                "action": "clear",
                "goal_id": view["id"],
                "revision": view["revision"]
            }),
        );
        assert_eq!(cleared.status, 200);
        let parsed = body_of(&cleared);
        assert_eq!(parsed["cleared"]["id"], view["id"]);
        assert_eq!(parsed["cleared"]["revision"], 2);
        assert!(get_goal(Some(&goals), Some("s1")).body.contains("null"));
    }

    #[test]
    fn post_refuses_an_unknown_action_and_an_invalid_block_reason() {
        let (_log, goals) = fixture("s1");
        let unknown = post_goal(Some(&goals), &json!({"session": "s1", "action": "dance"}));
        assert_eq!(unknown.status, 400);
        assert_eq!(body_of(&unknown)["error"], "unknown goal action \"dance\"");

        let created = post_goal(
            Some(&goals),
            &json!({"session": "s1", "action": "create", "objective": "one"}),
        );
        let view = body_of(&created)["goal"].clone();
        let bad = post_goal(
            Some(&goals),
            &json!({
                "session": "s1",
                "action": "blocked",
                "goal_id": view["id"],
                "revision": view["revision"],
                "blocked_reason": {"code": "Not A Code", "message": "x"}
            }),
        );
        assert_eq!(bad.status, 400);
        assert_eq!(body_of(&bad)["code"], "GOAL_INVALID_BLOCK_REASON");
    }

    #[test]
    fn post_answers_404_for_an_unknown_session_and_503_without_the_plugin() {
        let (_log, goals) = fixture("s1");
        assert_eq!(
            post_goal(None, &json!({"session": "s1", "action": "create"})).status,
            503
        );
        let unknown = post_goal(
            Some(&goals),
            &json!({"session": "nope", "action": "create", "objective": "one"}),
        );
        assert_eq!(unknown.status, 404);
        assert_eq!(body_of(&unknown)["error"], "no session nope");
    }
}
