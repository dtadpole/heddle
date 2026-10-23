//! `GET /api/goal?session=<id>` and `POST /api/goal`, answered as a status and the exact body bytes.
//!
//! The POST is the **person's** side of the verbs, so it may resume a paused goal, which the model's tool may
//! not. Errors carry the service's code beside the sentence: `GOAL_NOT_FOUND` is 404, `GOAL_STALE_REVISION` is
//! 409, any other failure 400. A success body is `JSON.stringify(value, null, 2)` plus a newline, an error body
//! compact JSON plus a newline, as the TypeScript server writes them.

use serde_json::Value;

use crate::service::GoalService;

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
    let _ = (goals, session);
    todo!("heddle-goal: get_goal")
}

/// Answer `POST /api/goal` with the parsed body `{session, action, goal_id?, revision?, objective?,
/// max_goal_rounds?, blocked_reason?}`; `action` is `create`, `edit`, `pause`, `resume`, `complete`, `blocked`
/// or `clear`. 200 `{"goal": view}` (`{"cleared": ref}` for a clear); 404 `no session <id>`; 400 for an unknown
/// action; a refusal as `{"error": sentence, "code": code}` with its status.
pub fn post_goal(goals: Option<&GoalService>, body: &Value) -> HttpAnswer {
    let _ = (goals, body);
    todo!("heddle-goal: post_goal")
}
