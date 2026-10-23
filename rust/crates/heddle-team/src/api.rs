//! The team's HTTP answer: `GET /api/team?session=<id>`, for the view that shows the roster, the shared board
//! and the mailbox ledger.
//!
//! Port of the `/api/team` branch of `src/server/web.ts`. The answer is the state the tools see — the folded
//! journal, the live statuses and the task views with readiness and write-scope warnings — because a view that
//! recomputed any of it would be a second truth.
//!
//! Framework-free: the server mounts the route and authenticates the request, calls [`team_api`] with the
//! `session` query parameter, and writes [`ApiResponse::status`] with [`ApiResponse::body_text`] as
//! `application/json`.

// Contract stage: the body below is `todo!()` until the route lands (port plan, step M4).
#![allow(unused_variables)]

use serde::Serialize;
use serde_json::Value;

use crate::service::{TeamMemberView, TeamService};
use crate::state::{SessionId, TeamMessageSnapshot, TeamTaskView};

/// The route's path.
pub const TEAM_ROUTE: &str = "/api/team";

/// The 200 body: `{ session, lead, members, tasks, messages, delivered }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TeamApiView {
    /// The session asked about.
    pub session: SessionId,
    /// Its team's Lead (itself when it is not a teammate).
    pub lead: SessionId,
    /// The Lead, then every teammate, with live status.
    pub members: Vec<TeamMemberView>,
    pub tasks: Vec<TeamTaskView>,
    /// Every queued message, delivered or not.
    pub messages: Vec<TeamMessageSnapshot>,
    /// The ids of delivered messages.
    pub delivered: Vec<String>,
}

/// A status and a JSON body.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiResponse {
    pub status: u16,
    pub body: Value,
}

impl ApiResponse {
    /// The body as the TypeScript server writes it: two-space indented JSON and a newline.
    pub fn body_text(&self) -> String {
        let mut text = serde_json::to_string_pretty(&self.body).expect("a JSON value serializes");
        text.push('\n');
        text
    }
}

/// Answer one `GET /api/team`.
///
/// - `service` is `None` when the profile does not load the team row: 503
///   `{ error: 'this profile does not load the team plugin' }`;
/// - `session` absent or empty: 400 `{ error: 'a session is required' }`;
/// - no such session: 404 `{ error: 'no session <id>' }`;
/// - a team log the fold refuses: 500 `{ error, code }`;
/// - otherwise 200 with a [`TeamApiView`] — a session with no team answers an empty roster of one (the Lead)
///   and an empty board, which is how the page knows to keep the panel hidden.
pub fn team_api(service: Option<&TeamService>, session: Option<&str>) -> ApiResponse {
    todo!("M4: port of the /api/team branch (src/server/web.ts)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_body_is_two_space_json_with_a_trailing_newline() {
        let response = ApiResponse {
            status: 400,
            body: json!({ "error": "a session is required" }),
        };
        assert_eq!(
            response.body_text(),
            "{\n  \"error\": \"a session is required\"\n}\n"
        );
    }
}
