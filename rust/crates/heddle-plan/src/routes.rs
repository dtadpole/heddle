//! The plan route, merged behind the server's door when the profile loads the `plan` row.
//!
//! Ported from `src/plan/http.ts`:
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /api/sessions/{id}/plan` | `200 {"session": id, "active": bool}` — whether the session is in plan mode, which the composer's Plan chip and placeholder follow when a session is shown; changes arrive afterwards as `plan/mode` session events |
//! | … an id that is not `session-<uuid>` | `400 {"error": "not a session id"}` |
//! | … an id no session has | `404 {"error": "no session <id>"}` |
//!
//! Every answer is `JSON.stringify(value, null, 2)` plus a newline, as `application/json` with
//! `cache-control: no-store` — `http.ts`'s `json` helper, which `heddle-commands` already ports. Any other method is
//! not this route's, and falls through to the server.

use std::sync::Arc;

use axum::Router;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use heddle_commands::routes::json_pretty;
use heddle_session::SessionHandle;
use serde_json::json;

use crate::text;

/// The route's path, in axum 0.8 syntax; the session segment is named `{id}`, as every route under
/// `/api/sessions/` must name it for the server's router to merge them.
pub const PLAN_ROUTE: &str = "/api/sessions/{id}/plan";

/// What the route reads.
pub trait PlanRouteHost: Send + Sync {
    /// The session `id` names, or `None`.
    fn open(&self, id: &str) -> Option<SessionHandle>;
    /// Whether the session is in plan mode.
    fn active(&self, session: &SessionHandle) -> bool;
}

/// The plan route, with its state applied, ready to be merged into the server's router.
pub fn router(host: Arc<dyn PlanRouteHost>) -> Router {
    Router::new()
        .route(PLAN_ROUTE, get(plan_state))
        .with_state(host)
}

fn refuse(status: StatusCode, message: &str) -> Response {
    json_pretty(status, &json!({ "error": message }))
}

async fn plan_state(
    State(host): State<Arc<dyn PlanRouteHost>>,
    id: Result<Path<String>, PathRejection>,
) -> Response {
    let Ok(Path(id)) = id else {
        return refuse(StatusCode::BAD_REQUEST, "not a session id");
    };
    if !text::is_session_id(&id) {
        return refuse(StatusCode::BAD_REQUEST, "not a session id");
    }
    let Some(handle) = host.open(&id) else {
        return refuse(StatusCode::NOT_FOUND, &format!("no session {id}"));
    };
    json_pretty(
        StatusCode::OK,
        &json!({ "session": id, "active": host.active(&handle) }),
    )
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, header};
    use serde_json::Value;

    use super::*;
    use crate::mode::{plan_active, set_plan_mode};
    use crate::test_support::{Fixture, body_text, call};

    struct Host(Arc<heddle_session::SessionStore>);

    impl PlanRouteHost for Host {
        fn open(&self, id: &str) -> Option<SessionHandle> {
            self.0.open(id)
        }

        fn active(&self, session: &SessionHandle) -> bool {
            self.0
                .read(session)
                .is_ok_and(|events| plan_active(events.as_slice()))
        }
    }

    /// The route merged into a caller's router the way the server merges it: anything it does not claim — another
    /// path, a wrong method — is left to the caller's fallback.
    fn app(fixture: &Fixture) -> Router {
        let teapot = || async { (StatusCode::IM_A_TEAPOT, "not mine\n") };
        Router::new()
            .merge(router(Arc::new(Host(fixture.store.clone()))))
            .fallback(teapot)
            .method_not_allowed_fallback(teapot)
    }

    async fn json_of(response: Response) -> Value {
        serde_json::from_str(&body_text(response).await).expect("a JSON answer")
    }

    #[tokio::test]
    async fn get_answers_whether_the_session_is_in_plan_mode() {
        let fixture = Fixture::new("route");
        let app = app(&fixture);
        let id = fixture.handle.id.clone();
        let path = format!("/api/sessions/{id}/plan");

        let off = call(app.clone(), Method::GET, &path).await;
        assert_eq!(off.status(), StatusCode::OK);
        assert_eq!(off.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(off.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            body_text(off).await,
            format!("{{\n  \"session\": \"{id}\",\n  \"active\": false\n}}\n"),
            "pretty, with a trailing newline, in the TypeScript key order"
        );

        set_plan_mode(fixture.log(), &fixture.handle, true).unwrap();
        assert_eq!(
            json_of(call(app.clone(), Method::GET, &path).await).await,
            json!({ "session": id, "active": true })
        );

        let not_an_id = call(app.clone(), Method::GET, "/api/sessions/nope/plan").await;
        assert_eq!(not_an_id.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(not_an_id).await,
            "{\n  \"error\": \"not a session id\"\n}\n"
        );
        let unknown = call(
            app.clone(),
            Method::GET,
            "/api/sessions/session-00000000-0000-4000-8000-000000000000/plan",
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            json_of(unknown).await,
            json!({ "error": "no session session-00000000-0000-4000-8000-000000000000" })
        );
        let undecodable = call(app.clone(), Method::GET, "/api/sessions/session%FF/plan").await;
        assert_eq!(undecodable.status(), StatusCode::BAD_REQUEST);
        let encoded = id.replacen("session-", "session%2D", 1);
        assert_eq!(
            json_of(
                call(
                    app.clone(),
                    Method::GET,
                    &format!("/api/sessions/{encoded}/plan")
                )
                .await
            )
            .await,
            json!({ "session": id, "active": true }),
            "the id is decoded before it is judged"
        );

        let posted = call(app.clone(), Method::POST, &path).await;
        assert_eq!(
            posted.status(),
            StatusCode::IM_A_TEAPOT,
            "only GET is the route"
        );
        let elsewhere = call(app, Method::GET, &format!("/api/sessions/{id}/planned")).await;
        assert_eq!(elsewhere.status(), StatusCode::IM_A_TEAPOT);
    }
}
