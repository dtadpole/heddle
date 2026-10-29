//! The page's reminder routes (`src/schedule/http.ts`): DSH's remote `schedule` namespace (`catalog`, `list`,
//! `history`, `update`, `delete`) over HTTP.
//!
//! There is no create route, as DSH has no remote create. The answers are the service's own values; a refused
//! input is `400 {code, message}` with DSH's code, and anything else is `500` with DSH's `internal_error` sentence.
//! Without the schedule row every route answers `503`, the way the goal and todo routes do.
//!
//! [`router`] serves every path under [`SCHEDULE_ROUTE_PREFIX`]; the binary mounts it beside the other page
//! routers, behind the server's own fence and token.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::any;
use serde_json::{Map, Value, json};

use crate::js;
use crate::rules::schedule_view;
use crate::service::{HistoryRequest, ScheduleService, ServiceError, UpdateRequest, catalog_entry};

/// Every request under this prefix is a reminder route.
pub const SCHEDULE_ROUTE_PREFIX: &str = "/api/schedule/";

/// The largest request body a route reads.
const MAX_BODY_BYTES: usize = 1_000_000;

/// One answer: a status and a JSON value.
pub type Answer = (u16, Value);

/// The routes, over the schedule service when the profile loads the row.
pub fn router(service: Option<Arc<ScheduleService>>) -> Router {
    Router::new()
        .route("/api/schedule/", any(route))
        .route("/api/schedule/{*rest}", any(route))
        .with_state(service)
}

/// `JSON.stringify(value, null, 2)` and a newline, as `application/json` that is never cached.
pub fn respond(status: u16, value: &Value) -> Response {
    let mut text = serde_json::to_string_pretty(value).expect("a value serializes");
    text.push('\n');
    let mut response = Response::new(Body::from(text));
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn route(State(service): State<Option<Arc<ScheduleService>>>, request: Request) -> Response {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let query: Vec<(String, String)> = Query::<Vec<(String, String)>>::try_from_uri(request.uri())
        .map(|Query(pairs)| pairs)
        .unwrap_or_default();
    let body = if method == "POST" {
        axum::body::to_bytes(request.into_body(), MAX_BODY_BYTES)
            .await
            .ok()
    } else {
        None
    };
    let (status, value) = answer(service.as_deref(), &method, &path, &query, body.as_deref()).await;
    respond(status, &value)
}

fn error(message: &str) -> Value {
    json!({ "error": message })
}

/// `url.searchParams.get(name)`, with an empty value read as absent.
fn required<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
        .filter(|value| !value.is_empty())
}

/// The body as one JSON object, or `None` when it is too large, not JSON, or not an object.
fn object(body: Option<&[u8]>) -> Option<Map<String, Value>> {
    let value: Value = serde_json::from_slice(body?).ok()?;
    value.as_object().cloned()
}

fn failure(error: &ServiceError) -> Answer {
    match error {
        ServiceError::Input(error) => (
            400,
            json!({ "code": error.code.as_str(), "message": error.message }),
        ),
        _ => (
            500,
            json!({ "code": "internal_error", "message": "The schedule operation failed." }),
        ),
    }
}

/// Answer one reminder request: the method, the path, the query pairs and, for a POST, the body that was read
/// (`None` when it could not be).
pub async fn answer(
    service: Option<&ScheduleService>,
    method: &str,
    path: &str,
    query: &[(String, String)],
    body: Option<&[u8]>,
) -> Answer {
    let Some(schedule) = service else {
        return (503, error("this profile does not load the schedule plugin"));
    };
    let route = format!("{method} {path}");
    match route.as_str() {
        "GET /api/schedule/catalog" => {
            let tasks: Vec<Value> = schedule.catalog().iter().map(catalog_entry).collect();
            (200, json!({ "tasks": tasks }))
        }
        "GET /api/schedule/list" => {
            let Some(session_id) = required(query, "session") else {
                return (400, error("a session is required"));
            };
            let now = schedule.now();
            let reminders: Vec<Value> = schedule
                .list(session_id)
                .iter()
                .map(|record| schedule_view(record, now))
                .collect();
            (
                200,
                json!({ "sessionId": session_id, "reminders": reminders }),
            )
        }
        "GET /api/schedule/history" => {
            let (Some(session_id), Some(id)) = (required(query, "session"), required(query, "id"))
            else {
                return (400, error("a session and a reminder id are required"));
            };
            let limit = match query.iter().find(|(key, _)| key == "limit") {
                None => 20,
                Some((_, text)) => {
                    let number = js::number(text);
                    if number.is_finite()
                        && number.fract() == 0.0
                        && number.abs() <= js::MAX_SAFE_INTEGER as f64
                    {
                        number as i64
                    } else {
                        0
                    }
                }
            };
            let request = HistoryRequest {
                session_id: session_id.to_owned(),
                id: id.to_owned(),
                limit,
                before: required(query, "before").map(str::to_owned),
            };
            match schedule.history(&request) {
                Ok(result) => (200, result.to_value()),
                Err(input) => failure(&ServiceError::Input(input)),
            }
        }
        "POST /api/schedule/update" => {
            let Some(body) = object(body) else {
                return (400, error("the body must be one JSON object"));
            };
            let (Some(session_id), Some(id)) = (
                body.get("sessionId").and_then(Value::as_str),
                body.get("id").and_then(Value::as_str),
            ) else {
                // Neither a string session nor a string id can name a task: the service's miss, its id echoed.
                let mut miss = Map::new();
                if let Some(id) = body.get("id") {
                    miss.insert("id".into(), id.clone());
                }
                miss.insert("updated".into(), Value::from(false));
                miss.insert("code".into(), Value::from("schedule_not_found"));
                return (200, Value::Object(miss));
            };
            let request = UpdateRequest {
                session_id: session_id.to_owned(),
                id: id.to_owned(),
                expected: body.get("expected").cloned().unwrap_or(Value::Null),
                title: body.get("title").cloned(),
                prompt: body.get("prompt").cloned(),
                change: body.get("change").cloned(),
            };
            match schedule.update(request, None).await {
                Ok(result) => (200, result.to_value()),
                Err(error) => failure(&error),
            }
        }
        "POST /api/schedule/delete" => {
            let pair = object(body).and_then(|body| {
                let session_id = body.get("sessionId")?.as_str()?.to_owned();
                let id = body.get("id")?.as_str()?.to_owned();
                Some((session_id, id))
            });
            let Some((session_id, id)) = pair else {
                return (400, error("the body must be {sessionId, id}"));
            };
            match schedule.delete(&session_id, &id, None).await {
                Ok(result) => (200, result.to_value()),
                Err(error) => failure(&error),
            }
        }
        _ => (404, error(&format!("no reminder route {route}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::tests::{args, setup_with};
    use tower::ServiceExt;

    async fn send(router: &Router, method: &str, uri: &str, body: Option<String>) -> (u16, Value) {
        let request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, Body::from))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get(router: &Router, uri: &str) -> (u16, Value) {
        send(router, "GET", uri, None).await
    }

    async fn post(router: &Router, uri: &str, body: Value) -> (u16, Value) {
        let text = match body {
            Value::String(text) => text,
            other => other.to_string(),
        };
        send(router, "POST", uri, Some(text)).await
    }

    #[tokio::test]
    async fn a_profile_without_the_schedule_plugin_answers_503_and_other_paths_are_not_this_module()
    {
        let router = router(None);
        assert_eq!(
            get(&router, "/api/schedule/catalog").await,
            (
                503,
                json!({"error": "this profile does not load the schedule plugin"})
            )
        );
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/goal")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "a path outside /api/schedule/ is left to the server"
        );
    }

    #[tokio::test]
    async fn list_answers_the_sessions_active_reminders_as_views_and_catalog_every_row() {
        let setup = setup_with("http-list", |_| ());
        let service = &setup.service;
        let record = service
            .create("session-1", &args(json!({"prompt": "Review", "title": "Daily review", "daily": {"time": "23:00:00", "time_zone": "Asia/Shanghai"}})), None)
            .await
            .unwrap();
        service
            .create(
                "session-2",
                &args(json!({"prompt": "Other", "title": "Other", "after_seconds": 60})),
                None,
            )
            .await
            .unwrap();
        let router = router(Some(Arc::clone(service)));
        let (status, listed) = get(&router, "/api/schedule/list?session=session-1").await;
        assert_eq!(status, 200);
        assert_eq!(listed["sessionId"], "session-1");
        let reminders = listed["reminders"].as_array().unwrap();
        assert_eq!(reminders.len(), 1);
        let keys: Vec<&String> = reminders[0].as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "id",
                "kind",
                "title",
                "prompt",
                "time",
                "timeZone",
                "scheduledAt",
                "state",
                "deliveryMode"
            ]
        );
        assert_eq!(reminders[0]["id"], json!(record.id));
        assert_eq!(reminders[0]["state"], "scheduled");
        let (_, catalog) = get(&router, "/api/schedule/catalog").await;
        let mut pairs: Vec<(String, String)> = catalog["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| {
                (
                    task["sessionId"].as_str().unwrap().to_owned(),
                    task["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            [
                ("session-1".to_owned(), "active".to_owned()),
                ("session-2".to_owned(), "active".to_owned())
            ]
        );
        assert_eq!(
            get(&router, "/api/schedule/list").await.0,
            400,
            "list needs a session"
        );
    }

    #[tokio::test]
    async fn update_is_a_compare_and_set_over_the_complete_expected_record() {
        let setup = setup_with("http-update", |_| ());
        let service = &setup.service;
        let record = service
            .create("session-1", &args(json!({"prompt": "Review", "title": "Daily review", "daily": {"time": "23:00:00", "time_zone": "Asia/Shanghai"}})), None)
            .await
            .unwrap();
        let router = router(Some(Arc::clone(service)));
        let (status, renamed) = post(&router, "/api/schedule/update", json!({"sessionId": "session-1", "id": record.id, "expected": record, "title": "Evening review"})).await;
        assert_eq!(status, 200);
        assert_eq!(renamed["updated"], true);
        assert_eq!(renamed["record"]["title"], "Evening review");
        let (_, stale) = post(&router, "/api/schedule/update", json!({"sessionId": "session-1", "id": record.id, "expected": record, "title": "Lost edit"})).await;
        assert_eq!(
            stale,
            json!({"id": record.id, "updated": false, "code": "schedule_conflict"}),
            "the old record no longer matches"
        );
        let (_, elsewhere) = post(
            &router,
            "/api/schedule/update",
            json!({"sessionId": "session-2", "id": record.id, "expected": record, "title": "x"}),
        )
        .await;
        assert_eq!(
            elsewhere,
            json!({"id": record.id, "updated": false, "code": "schedule_not_found"}),
            "another session cannot reach it"
        );
        assert_eq!(
            post(&router, "/api/schedule/update", json!("[1, 2]"))
                .await
                .0,
            400,
            "the body must be one JSON object"
        );
    }

    #[tokio::test]
    async fn a_refused_input_answers_400_with_dsh_code_and_sentence() {
        let setup = setup_with("http-refused", |_| ());
        let record = setup
            .service
            .create(
                "session-1",
                &args(json!({"prompt": "Review", "title": "Daily review", "every_seconds": 600})),
                None,
            )
            .await
            .unwrap();
        let router = router(Some(Arc::clone(&setup.service)));
        let answer = get(
            &router,
            &format!(
                "/api/schedule/history?session=session-1&id={}&limit=0",
                record.id
            ),
        )
        .await;
        assert_eq!(
            answer,
            (
                400,
                json!({"code": "invalid_rule", "message": "Delivery history limit must be a safe integer from 1 through 100."})
            )
        );
    }

    #[tokio::test]
    async fn history_answers_the_newest_records_first_with_the_retention_and_delete_removes_the_task_once()
     {
        let setup = setup_with("http-history", |_| ());
        let record = setup
            .service
            .create(
                "session-1",
                &args(json!({"prompt": "Review", "title": "Daily review", "every_seconds": 600})),
                None,
            )
            .await
            .unwrap();
        let router = router(Some(Arc::clone(&setup.service)));
        let (status, history) = get(
            &router,
            &format!("/api/schedule/history?session=session-1&id={}", record.id),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(
            history,
            json!({"id": record.id, "records": [], "earlierRecordsUnavailable": false, "earlierRecordsPruned": false, "retention": {"days": 30, "records": 200}})
        );
        assert_eq!(
            post(
                &router,
                "/api/schedule/delete",
                json!({"sessionId": "session-1", "id": record.id})
            )
            .await
            .1,
            json!({"id": record.id, "deleted": true})
        );
        assert_eq!(
            post(
                &router,
                "/api/schedule/delete",
                json!({"sessionId": "session-1", "id": record.id})
            )
            .await
            .1,
            json!({"id": record.id, "deleted": false, "code": "schedule_not_found"})
        );
        assert_eq!(
            post(&router, "/api/schedule/delete", json!({"id": record.id}))
                .await
                .0,
            400,
            "delete needs {{sessionId, id}}"
        );
        assert_eq!(get(&router, "/api/schedule/nothing").await.0, 404);
    }
}
