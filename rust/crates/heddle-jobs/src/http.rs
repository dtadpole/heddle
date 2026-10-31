//! The person's job routes: DSH's `jobController` (`dsh-api-job-controller/lib/index.js:324-373`) over HTTP, ported
//! from `src/jobs/http.ts`.
//!
//! - `GET /api/jobs?session=<id>` — `{jobs}`: the session's jobs plus the unowned ones (DSH's `job.list` frame).
//! - `GET /api/jobs/follow?session=&job=&from=<offset>` — `{job, chunks, next, lossy?, settled}`: one non-consuming
//!   read from an absolute offset (DSH's `job.follow`). It uses only `get` and `read_at`, so the model's cursor never
//!   moves: what the page shows, the model's next `job_output` still returns.
//! - `POST /api/jobs/kill {session, job}` — `{outcome}`: a kill with reason `cancelled by the user`. It is not the
//!   model's kill, so the completion notice is still sent.
//!
//! A job the session cannot see, and an unknown one, are `404 {code: 'job/not-found', message}` (DSH's code). Without
//! the jobs row every route answers `503`, as the schedule and goal routes do.

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::any;
use serde_json::{Map, Value, json};

use crate::js::number_from_text;
use crate::registry::{JobError, JobRegistry, codes};

/// The route every job path starts with.
pub const JOBS_ROUTE: &str = "/api/jobs";

/// The largest request body a route reads; a kill carries two ids.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// One answer: a status and a JSON value.
pub type Answer = (u16, Value);

/// The routes, over the registry when the profile loads the jobs row.
pub fn router(jobs: Option<JobRegistry>) -> Router {
    Router::new()
        .route("/api/jobs", any(route))
        .route("/api/jobs/", any(route))
        .route("/api/jobs/{*rest}", any(route))
        .with_state(jobs)
}

/// `JSON.stringify(value, null, 2)` and a newline, as `application/json` that is never cached.
fn respond(status: u16, value: &Value) -> Response {
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

async fn route(State(jobs): State<Option<JobRegistry>>, request: Request) -> Response {
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
    let (status, value) = answer(jobs.as_ref(), &method, &path, &query, body.as_deref());
    respond(status, &value)
}

fn error(message: &str) -> Value {
    json!({ "error": message })
}

/// `url.searchParams.get(name)`, with an empty value read as absent.
fn param<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
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

/// A registry refusal as the route answers it: an unseen job is DSH's `job/not-found`; a bad offset is a 400; a
/// failed cancel is the TypeScript build's `500`.
fn refuse(error: JobError) -> Answer {
    if error.code == codes::JOB_UNKNOWN || error.code == codes::JOB_FOREIGN {
        return (
            404,
            json!({ "code": "job/not-found", "message": error.message }),
        );
    }
    if error.code == codes::JOB_CANCEL_FAILED {
        return (
            500,
            json!({ "code": "internal_error", "message": "The job operation failed." }),
        );
    }
    (400, json!({ "code": error.code, "message": error.message }))
}

/// Answer one job request: the method, the path, the query pairs and, for a POST, the body that was read (`None`
/// when it could not be).
pub fn answer(
    jobs: Option<&JobRegistry>,
    method: &str,
    path: &str,
    query: &[(String, String)],
    body: Option<&[u8]>,
) -> Answer {
    let Some(jobs) = jobs else {
        return (503, error("this profile does not load the jobs plugin"));
    };
    let route = format!("{method} {path}");
    let result = match route.as_str() {
        "GET /api/jobs" => {
            let Some(session) = param(query, "session") else {
                return (400, error("a session is required"));
            };
            Ok((200, json!({ "jobs": jobs.list(Some(session)) })))
        }
        "GET /api/jobs/follow" => {
            let (Some(session), Some(id)) = (param(query, "session"), param(query, "job")) else {
                return (400, error("a session and a job are required"));
            };
            let from = param(query, "from").map_or(0.0, number_from_text);
            // The view first: a job that has settled appends nothing more, so a read after it holds every byte.
            jobs.get(id, Some(session)).and_then(|job| {
                let read = jobs.read_at(id, from, Some(session))?;
                let mut answer = Map::new();
                answer.insert("job".into(), json!(job));
                answer.insert("chunks".into(), json!(read.chunks));
                answer.insert("next".into(), json!(read.next));
                if read.lossy {
                    answer.insert("lossy".into(), json!(true));
                }
                answer.insert("settled".into(), json!(job.status.is_terminal()));
                Ok((200, Value::Object(answer)))
            })
        }
        "POST /api/jobs/kill" => {
            let body = object(body);
            let (Some(session), Some(id)) = (
                body.as_ref()
                    .and_then(|body| body.get("session"))
                    .and_then(Value::as_str),
                body.as_ref()
                    .and_then(|body| body.get("job"))
                    .and_then(Value::as_str),
            ) else {
                return (400, error("the body must be {session, job}"));
            };
            jobs.get(id, Some(session))
                .and_then(|_| jobs.kill(id, Some(session), Some("cancelled by the user")))
                .map(|outcome| (200, json!({ "outcome": outcome.as_str() })))
        }
        _ => return (404, error(&format!("no job route {route}"))),
    };
    result.unwrap_or_else(refuse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::tests::{Events, manual_spec, settled_of};
    use crate::registry::{JobOutcome, JobRegistryOptions, OutcomeStatus};
    use crate::ring::{AppendOptions, JobChannel};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    fn setup() -> (JobRegistry, Events) {
        let jobs = JobRegistry::new(JobRegistryOptions {
            session_exists: Some(Arc::new(|id: &str| id.starts_with("session-"))),
            retain_bytes: Some(8),
            ..JobRegistryOptions::default()
        });
        let _ = jobs.attach_controller("test");
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        let _ = jobs.subscribe(move |event| seen.lock().unwrap().push(event.clone()));
        (jobs, events)
    }

    fn start(jobs: &JobRegistry, owner: Option<&str>) -> (String, crate::registry::tests::Manual) {
        let (spec, manual) = manual_spec(
            owner,
            "tail -f log",
            Some(JobOutcome::new(
                OutcomeStatus::Killed,
                Some("signal: SIGTERM"),
            )),
        );
        (jobs.start(spec).unwrap(), manual)
    }

    async fn call(
        jobs: Option<JobRegistry>,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (u16, Value, String) {
        let request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(
                body.map(|body| body.to_string()).unwrap_or_default(),
            ))
            .unwrap();
        let response = router(jobs).oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_api_jobs_lists_the_sessions_jobs_plus_the_unowned_ones() {
        let (jobs, _) = setup();
        let (mine, _) = start(&jobs, Some("session-a"));
        start(&jobs, Some("session-b"));
        let (open, _) = start(&jobs, None);
        let (status, body, text) = call(
            Some(jobs.clone()),
            "GET",
            "/api/jobs?session=session-a",
            None,
        )
        .await;
        assert_eq!(status, 200);
        let ids: Vec<&str> = body["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|job| job["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, [mine.as_str(), open.as_str()]);
        assert_eq!(body["jobs"][0]["owner"], "session-a");
        assert_eq!(
            body["jobs"][0]["output"],
            json!({ "total": 0, "earliest": 0 })
        );
        assert!(
            text.starts_with("{\n  \"jobs\": [\n    {\n      \"id\": "),
            "{text}"
        );
        assert!(text.ends_with("}\n"));
        assert_eq!(
            call(Some(jobs.clone()), "GET", "/api/jobs", None).await.0,
            400
        );
        assert_eq!(
            call(Some(jobs), "GET", "/api/jobs/nope", None).await.1,
            json!({ "error": "no job route GET /api/jobs/nope" })
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn follow_reads_without_consuming_and_the_models_next_read_still_returns_the_output() {
        let (jobs, events) = setup();
        let (id, manual) = start(&jobs, Some("session-a"));
        let stdout = AppendOptions::channel(JobChannel::Stdout);
        manual.handle().append("one\n", stdout);
        let base = format!("/api/jobs/follow?session=session-a&job={id}");
        let (_, first, _) = call(Some(jobs.clone()), "GET", &format!("{base}&from=0"), None).await;
        assert_eq!(
            first["chunks"],
            json!([{ "at": 0, "text": "one\n", "channel": "stdout" }])
        );
        assert_eq!(first["next"], 4);
        assert_eq!(first["settled"], false);
        assert!(first.get("lossy").is_none());
        assert_eq!(first["job"]["status"], "running");
        assert_eq!(
            first
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["job", "chunks", "next", "settled"]
        );
        manual.handle().append("two\n", stdout);
        let (_, second, _) = call(Some(jobs.clone()), "GET", &format!("{base}&from=4"), None).await;
        assert_eq!(second["chunks"][0]["text"], "two\n");
        assert_eq!(second["chunks"].as_array().unwrap().len(), 1);
        let read = jobs.read(&id, Some("session-a")).unwrap();
        assert_eq!(
            read.chunks
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect::<Vec<_>>(),
            ["one\n", "two\n"],
            "the model never saw any of it"
        );
        manual.handle().append("three\n", stdout);
        let (_, lossy, _) = call(Some(jobs.clone()), "GET", &base, None).await;
        assert_eq!(
            lossy["lossy"], true,
            "from defaults to 0, below what an 8-byte ring keeps"
        );
        manual.finish(JobOutcome::new(
            OutcomeStatus::Completed,
            Some("exit code: 0"),
        ));
        settled_of(&events, &id).await;
        let (_, done, _) = call(Some(jobs.clone()), "GET", &format!("{base}&from=8"), None).await;
        assert_eq!(done["settled"], true);
        assert_eq!(done["job"]["status"], "completed");
        let (status, bad, _) = call(Some(jobs), "GET", &format!("{base}&from=-3"), None).await;
        assert_eq!(status, 400);
        assert_eq!(
            bad,
            json!({ "code": "JOB_INVALID_ARGS", "message": "invalid output read offset: expected a non-negative safe integer, got -3" })
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn kill_uses_the_users_reason_and_unknown_or_foreign_jobs_are_not_found() {
        let (jobs, events) = setup();
        let (id, manual) = start(&jobs, Some("session-a"));
        let post = |body: Value| {
            let jobs = jobs.clone();
            async move { call(Some(jobs), "POST", "/api/jobs/kill", Some(body)).await }
        };
        let (status, foreign, _) = post(json!({ "session": "session-b", "job": id })).await;
        assert_eq!(status, 404);
        assert_eq!(
            foreign,
            json!({ "code": "job/not-found", "message": format!("job {id} belongs to another session") })
        );
        let (status, unknown, _) =
            post(json!({ "session": "session-a", "job": "bash-0000000000000000" })).await;
        assert_eq!(status, 404);
        assert_eq!(
            unknown,
            json!({ "code": "job/not-found", "message": "unknown job bash-0000000000000000" })
        );
        let follow = call(
            Some(jobs.clone()),
            "GET",
            &format!("/api/jobs/follow?session=session-b&job={id}"),
            None,
        )
        .await;
        assert_eq!(follow.0, 404);
        let (status, killed, _) = post(json!({ "session": "session-a", "job": id })).await;
        assert_eq!(status, 200);
        assert_eq!(killed, json!({ "outcome": "requested" }));
        assert_eq!(manual.cancels(), [Some("cancelled by the user".to_owned())]);
        let (job, _, _) = settled_of(&events, &id).await;
        assert_eq!(
            job.detail.as_deref(),
            Some("signal: SIGTERM; cancelled by the user")
        );
        assert_eq!(
            post(json!({ "session": "session-a", "job": id })).await.1,
            json!({ "outcome": "already-finished" })
        );
        assert_eq!(post(json!({ "session": "session-a" })).await.0, 400);
    }

    #[tokio::test]
    async fn without_the_jobs_row_the_routes_answer_503() {
        let (status, body, _) = call(None, "GET", "/api/jobs?session=session-a", None).await;
        assert_eq!(status, 503);
        assert_eq!(
            body,
            json!({ "error": "this profile does not load the jobs plugin" })
        );
    }
}
