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

use serde::Serialize;
use serde_json::{Value, json};

use crate::error::TeamError;
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
    let Some(service) = service else {
        return ApiResponse {
            status: 503,
            body: json!({ "error": "this profile does not load the team plugin" }),
        };
    };
    let Some(session) = session.filter(|wanted| !wanted.is_empty()) else {
        return ApiResponse {
            status: 400,
            body: json!({ "error": "a session is required" }),
        };
    };
    if !service.session_exists(session) {
        return ApiResponse {
            status: 404,
            body: json!({ "error": format!("no session {session}") }),
        };
    }
    let state = match service.state(session) {
        Ok(state) => state,
        Err(error) => return refusal(500, &error),
    };
    let members = match service.list(session) {
        Ok(members) => members,
        Err(error) => return refusal(500, &error),
    };
    let tasks = match service.tasks(session) {
        Ok(tasks) => tasks,
        Err(error) => return refusal(500, &error),
    };
    ApiResponse {
        status: 200,
        body: serde_json::to_value(TeamApiView {
            session: session.to_owned(),
            lead: state.id,
            members,
            tasks,
            messages: state.messages,
            delivered: state.delivered,
        })
        .expect("the team view serializes"),
    }
}

/// A refusal with the fold's code, for a team whose log the state layer will not read.
fn refusal(status: u16, error: &TeamError) -> ApiResponse {
    ApiResponse {
        status,
        body: json!({ "error": error.message, "code": error.code.as_str() }),
    }
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

    // --- M4: GET /api/team ---

    use std::sync::Arc;

    use crate::ports::{SessionMetaView, TeamRunner, TeamStore};
    use crate::service::{SendRequest, SpawnRequest, TaskUpdate, TeamDeps, TeamLimits};
    use crate::state::{NewTask, TeamMemberContext, TeamTaskAction};
    use crate::testing::{MemoryStore, RecordingRunner, SequentialIds};

    fn service_with_lead() -> (Arc<MemoryStore>, Arc<TeamService>) {
        let store = Arc::new(MemoryStore::new());
        store.add_session(SessionMetaView {
            id: "session-lead".to_owned(),
            cwd: Some("/work".to_owned()),
            endpoint: Some("scripted".to_owned()),
            model: Some("m".to_owned()),
            team_id: None,
        });
        let runner = Arc::new(RecordingRunner::new(Arc::clone(&store), None));
        let store_dependency: Arc<dyn TeamStore> = store.clone();
        let runner_dependency: Arc<dyn TeamRunner> = runner.clone();
        let service = Arc::new(TeamService::new(TeamDeps {
            store: store_dependency,
            runner: runner_dependency,
            live: None,
            limits: TeamLimits::default(),
            notify: None,
            warn: None,
            ids: Arc::new(SequentialIds::new()),
        }));
        (store, service)
    }

    #[test]
    fn a_profile_without_the_team_row_answers_503() {
        let response = team_api(None, Some("session-lead"));
        assert_eq!(response.status, 503);
        assert_eq!(
            response.body["error"],
            "this profile does not load the team plugin"
        );
    }

    #[test]
    fn a_missing_or_empty_session_is_400() {
        let (_store, service) = service_with_lead();
        for session in [None, Some("")] {
            let response = team_api(Some(&service), session);
            assert_eq!(response.status, 400);
            assert_eq!(response.body["error"], "a session is required");
        }
    }

    #[test]
    fn an_unknown_session_is_404() {
        let (_store, service) = service_with_lead();
        let response = team_api(Some(&service), Some("session-nowhere"));
        assert_eq!(response.status, 404);
        assert_eq!(response.body["error"], "no session session-nowhere");
    }

    #[test]
    fn a_session_with_no_team_answers_a_roster_of_one_and_an_empty_board() {
        let (_store, service) = service_with_lead();
        let response = team_api(Some(&service), Some("session-lead"));
        assert_eq!(response.status, 200);
        assert_eq!(response.body["session"], "session-lead");
        assert_eq!(response.body["lead"], "session-lead");
        assert_eq!(response.body["members"].as_array().unwrap().len(), 1);
        assert_eq!(response.body["members"][0]["name"], "lead");
        assert_eq!(response.body["tasks"], json!([]));
        assert_eq!(response.body["messages"], json!([]));
        assert_eq!(response.body["delivered"], json!([]));
        assert!(response.body_text().ends_with('\n'));
    }

    #[tokio::test]
    async fn the_answer_is_the_state_the_tools_see() {
        let (_store, service) = service_with_lead();
        service
            .spawn(
                "session-lead",
                SpawnRequest {
                    name: "alpha".to_owned(),
                    description: "the teammate".to_owned(),
                    prompt: "write the thing".to_owned(),
                    context: TeamMemberContext::Fresh,
                },
            )
            .unwrap();
        let created = service
            .create_task(
                "session-lead",
                NewTask {
                    subject: "write the thing".to_owned(),
                    ..NewTask::default()
                },
            )
            .unwrap();
        service
            .update_task(
                "session-lead",
                TaskUpdate {
                    task_id: created.id.clone(),
                    revision: 1,
                    action: TeamTaskAction::Claim,
                    subject: None,
                    description: None,
                    blocked_by: None,
                    write_scopes: None,
                    owner_id: None,
                },
            )
            .unwrap();
        service
            .update_task(
                "session-lead",
                TaskUpdate {
                    task_id: created.id.clone(),
                    revision: 2,
                    action: TeamTaskAction::Complete,
                    subject: None,
                    description: None,
                    blocked_by: None,
                    write_scopes: None,
                    owner_id: None,
                },
            )
            .unwrap();
        let sent = service
            .send(
                "session-lead",
                SendRequest {
                    target: "alpha".to_owned(),
                    content: vec![json!({ "type": "text", "text": "mailed" })],
                },
            )
            .await
            .unwrap();
        let response = team_api(Some(&service), Some("session-lead"));
        assert_eq!(response.status, 200);
        assert_eq!(response.body["members"].as_array().unwrap().len(), 2);
        assert_eq!(response.body["tasks"][0]["status"], "completed");
        assert_eq!(response.body["messages"][0]["id"], sent.message_id);
        assert_eq!(response.body["delivered"][0], sent.message_id);
    }

    #[test]
    fn a_corrupt_team_answers_500_with_the_folds_code() {
        let (store, service) = service_with_lead();
        store
            .append(
                "session-lead",
                json!({
                    "type": "team/member",
                    "version": 2,
                    "teamId": "session-lead",
                    "member": { "id": "session-ghost", "name": "ghost", "description": "x", "context": "fresh", "phase": "active" },
                }),
            )
            .unwrap();
        let response = team_api(Some(&service), Some("session-lead"));
        assert_eq!(response.status, 500);
        assert_eq!(response.body["code"], "TEAM_MEMBER_PHASE");
        assert!(
            response.body["error"]
                .as_str()
                .unwrap()
                .contains("must start provisioning")
        );
    }
}
