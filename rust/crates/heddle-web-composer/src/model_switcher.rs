//! The model switcher: `GET /api/endpoints` and `POST /api/sessions/{id}/model`.
//!
//! Ported from the two routes of `src/server/web.ts`. The list is the model service's own — **never** the
//! configuration file, because a machine's endpoints are resolved from several layers — and it is said through
//! `describeEndpoints`, the one function that knows what is safe to say: a key, a key path and a header value
//! never reach a browser. An endpoint that declares no context window asks its provider's model list, and a
//! provider that cannot answer leaves the entry without one, so the page prints no percentage.
//!
//! A switch changes the session's **record**, not its append-only log, and every name in it is validated
//! against the model service, because this is the one place a name from a browser reaches the store.
//!
//! `POST /api/sessions/{id}/model`, body `{"endpoint": "...", "model"?: "...", "reasoningEffort"?: "..."}`:
//!
//! | Answer | When |
//! |---|---|
//! | `400 {"error":"not a session id"}` | the id is not `session-<uuid>` |
//! | `400` / `413` plain text | the body is not JSON / is larger than 10 MiB |
//! | `400 {"error":"an endpoint is required"}` | `endpoint` missing or blank |
//! | `400 {"error":"no endpoint named '<e>'; configured: <a, b>"}` | not one of [`ModelHost::endpoint_names`] |
//! | `400 {"error":"<selectionProblem>"}` | the model or effort is not one the endpoint declares |
//! | `404 {"error":"no session <id>"}` | [`ModelHost::set_session_model`] found no session |
//! | `200` the session's updated record, pretty | otherwise |

use std::future::Future;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::http::{error, is_session_id, json_pretty, read_json, trimmed_field};
use crate::session::SessionLookup;

/// What the model switcher reads from and writes to the running harness.
pub trait ModelHost: SessionLookup {
    /// `describeEndpoints(ctx.model.list(), ctx.model.defaultEndpoint())`: every endpoint as the page may see
    /// it, in the service's order, and the default when it names a configured endpoint.
    fn describe_endpoints(&self) -> EndpointListing;

    /// `contextWindowFromModelList(endpoint)`: the window the provider's model list reports for the endpoint's
    /// model, or `None` when it cannot say. Only asked for an endpoint whose description has no
    /// `contextWindow`.
    fn discover_context_window(&self, endpoint: &str) -> impl Future<Output = Option<u64>> + Send;

    /// `ctx.model.names()`: the configured endpoint names, in the service's order.
    fn endpoint_names(&self) -> Vec<String>;

    /// `selectionProblem(ctx.model.endpoint(endpoint), model, effort)`: the sentence that refuses a model or an
    /// effort level the endpoint does not declare, or `None` when the selection is acceptable (or the endpoint
    /// is unknown to the service).
    fn selection_problem(
        &self,
        endpoint: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Option<String>;

    /// `ctx.session.setModel(id, choice)`: record the choice on the session's record and answer the updated
    /// record as JSON, or `None` when there is no such session. Omitted fields clear the session's override.
    fn set_session_model(&self, id: &str, choice: &ModelChoice) -> Option<Value>;
}

/// The endpoints the page may see (`describeEndpoints`' answer).
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct EndpointListing {
    /// One `describeEndpoint` object per endpoint, passed through as the configuration crate shapes it.
    pub endpoints: Vec<Map<String, Value>>,
    /// The nominated default, when it names a configured endpoint; else `null`.
    pub default: Option<String>,
}

/// A switch, validated: the endpoint, and the overrides it carries.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModelChoice {
    pub endpoint: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// Merge discovered windows into a listing: an entry without `contextWindow` whose discovery answered gains
/// `contextWindow` and `contextWindowSource: "provider-models"`. `discovered[i]` belongs to `endpoints[i]`.
pub fn with_discovered_windows(
    mut listing: EndpointListing,
    discovered: &[Option<u64>],
) -> EndpointListing {
    for (index, entry) in listing.endpoints.iter_mut().enumerate() {
        let Some(Some(window)) = discovered.get(index) else {
            continue;
        };
        entry.insert("contextWindow".to_owned(), json!(window));
        entry.insert("contextWindowSource".to_owned(), json!("provider-models"));
    }
    listing
}

/// Validate a switch body against the model service, in the TypeScript route's order: endpoint required, then
/// configured, then the model and effort declared. `Err` is the sentence of the `400`.
pub fn validate_model_switch<H: ModelHost + ?Sized>(
    host: &H,
    body: &Map<String, Value>,
) -> Result<ModelChoice, String> {
    let endpoint =
        trimmed_field(body, "endpoint").ok_or_else(|| "an endpoint is required".to_owned())?;
    let names = host.endpoint_names();
    if !names.iter().any(|name| name == endpoint) {
        return Err(format!(
            "no endpoint named '{endpoint}'; configured: {}",
            names.join(", ")
        ));
    }
    let model = trimmed_field(body, "model");
    let reasoning_effort = trimmed_field(body, "reasoningEffort");
    if let Some(problem) = host.selection_problem(endpoint, model, reasoning_effort) {
        return Err(problem);
    }
    Ok(ModelChoice {
        endpoint: endpoint.to_owned(),
        model: model.map(str::to_owned),
        reasoning_effort: reasoning_effort.map(str::to_owned),
    })
}

/// `GET /api/endpoints` and `POST /api/sessions/{id}/model`.
pub fn routes<H: ModelHost>(host: Arc<H>) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/endpoints",
            get(move |State(host): State<Arc<H>>| async move {
                let listing = host.describe_endpoints();
                // Only an endpoint that declares no window asks its provider; a provider that cannot answer
                // leaves the entry without one.
                let mut discovered = Vec::with_capacity(listing.endpoints.len());
                for entry in &listing.endpoints {
                    if entry.contains_key("contextWindow") {
                        discovered.push(None);
                        continue;
                    }
                    let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
                    discovered.push(host.discover_context_window(name).await);
                }
                json_pretty(
                    StatusCode::OK,
                    &with_discovered_windows(listing, &discovered),
                )
            }),
        )
        .route(
            "/api/sessions/{id}/model",
            post(
                move |State(host): State<Arc<H>>, Path(id): Path<String>, body: Bytes| async move {
                    if !is_session_id(&id) {
                        return error(StatusCode::BAD_REQUEST, "not a session id");
                    }
                    let body = match read_json(&body) {
                        Ok(body) => body,
                        Err(refusal) => return refusal.into_response(),
                    };
                    let choice = match validate_model_switch(&*host, &body) {
                        Ok(choice) => choice,
                        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
                    };
                    match host.set_session_model(&id, &choice) {
                        Some(meta) => json_pretty(StatusCode::OK, &meta),
                        None => error(StatusCode::NOT_FOUND, &format!("no session {id}")),
                    }
                },
            ),
        )
        .with_state(host)
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use serde_json::json;

    use super::*;
    use crate::test_support::{Host, assert_answer_headers, body_text, call};

    const SESSION: &str = "session-00000000-0000-4000-8000-000000000000";

    fn listing(entries: Vec<Value>) -> EndpointListing {
        EndpointListing {
            endpoints: entries
                .into_iter()
                .map(|entry| entry.as_object().expect("an object entry").clone())
                .collect(),
            default: Some("scripted".to_owned()),
        }
    }

    #[test]
    fn a_discovered_window_joins_only_the_entry_that_lacked_one() {
        let found = with_discovered_windows(
            listing(vec![
                json!({"name": "a"}),
                json!({"name": "b", "contextWindow": 1000}),
            ]),
            &[Some(4200), Some(9999)],
        );
        assert_eq!(found.endpoints[0]["contextWindow"], 4200);
        assert_eq!(found.endpoints[0]["contextWindowSource"], "provider-models");
        // The declarative value wins: the host is asked only when none was declared, so a stray answer here
        // would be a bug in the host, and the TypeScript overwrites it the same way.
        assert_eq!(found.endpoints[1]["contextWindow"], 9999);

        let quiet = with_discovered_windows(listing(vec![json!({"name": "a"})]), &[None]);
        assert!(
            !quiet.endpoints[0].contains_key("contextWindow"),
            "an unanswerable provider leaves no window"
        );
    }

    #[test]
    fn a_switch_is_validated_in_the_typescript_order() {
        let mut host = Host::default();
        assert_eq!(
            validate_model_switch(&host, &json!({}).as_object().unwrap().clone()),
            Err("an endpoint is required".to_owned())
        );
        assert_eq!(
            validate_model_switch(
                &host,
                &json!({"endpoint": "  "}).as_object().unwrap().clone()
            ),
            Err("an endpoint is required".to_owned()),
            "a blank endpoint is missing"
        );
        assert_eq!(
            validate_model_switch(
                &host,
                &json!({"endpoint": "nope"}).as_object().unwrap().clone()
            ),
            Err("no endpoint named 'nope'; configured: scripted".to_owned())
        );

        host.names = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(
            validate_model_switch(
                &host,
                &json!({"endpoint": "c"}).as_object().unwrap().clone()
            ),
            Err("no endpoint named 'c'; configured: a, b".to_owned())
        );

        host.selection_problem = Some("model 'x' is not declared".to_owned());
        assert_eq!(
            validate_model_switch(
                &host,
                &json!({"endpoint": "a", "model": "x"})
                    .as_object()
                    .unwrap()
                    .clone()
            ),
            Err("model 'x' is not declared".to_owned()),
            "the service's own sentence travels unchanged"
        );

        host.selection_problem = None;
        let choice = validate_model_switch(
            &host,
            &json!({"endpoint": " a ", "model": " m ", "reasoningEffort": " high "})
                .as_object()
                .unwrap()
                .clone(),
        )
        .expect("a valid switch");
        assert_eq!(choice.endpoint, "a");
        assert_eq!(choice.model.as_deref(), Some("m"));
        assert_eq!(choice.reasoning_effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn the_endpoint_list_answers_its_windows_and_the_nominated_default() {
        let mut host = Host {
            endpoints: listing(vec![json!({"name": "scripted"})]),
            ..Host::default()
        };
        host.discovered.insert("scripted".to_owned(), Some(128_000));
        let response = call(routes(Arc::new(host)), Method::GET, "/api/endpoints", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_answer_headers(&response, crate::http::JSON_CONTENT_TYPE);
        let body: Value = serde_json::from_str(&body_text(response).await).expect("a JSON body");
        assert_eq!(body["default"], "scripted");
        assert_eq!(body["endpoints"][0]["contextWindow"], 128_000);
        assert_eq!(
            body["endpoints"][0]["contextWindowSource"],
            "provider-models"
        );
    }

    #[tokio::test]
    async fn a_switch_refuses_what_the_route_table_says_it_refuses() {
        let host = Host::with_session(SESSION, Vec::new());
        let router = routes(Arc::new(host));

        let response = call(
            router.clone(),
            Method::POST,
            "/api/sessions/not-a-session/model",
            Some("{}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"not a session id\"}\n"
        );

        let response = call(
            router.clone(),
            Method::POST,
            &format!("/api/sessions/{SESSION}/model"),
            Some("not json"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_text(response).await, "the body must be JSON\n");

        let response = call(
            router.clone(),
            Method::POST,
            &format!("/api/sessions/{SESSION}/model"),
            Some("{}"),
        )
        .await;
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"an endpoint is required\"}\n"
        );

        let response = call(
            router.clone(),
            Method::POST,
            &format!("/api/sessions/{SESSION}/model"),
            Some("{\"endpoint\":\"nope\"}"),
        )
        .await;
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"no endpoint named 'nope'; configured: scripted\"}\n"
        );

        let response = call(
            router,
            Method::POST,
            "/api/sessions/session-00000000-0000-4000-8000-000000000001/model",
            Some("{\"endpoint\":\"scripted\"}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_text(response).await,
            "{\"error\":\"no session session-00000000-0000-4000-8000-000000000001\"}\n"
        );
    }

    #[tokio::test]
    async fn a_valid_switch_records_the_choice_and_answers_the_record() {
        let host = Host::with_session(SESSION, Vec::new());
        let logged = Arc::clone(&host.switched);
        let response = call(
            routes(Arc::new(host)),
            Method::POST,
            &format!("/api/sessions/{SESSION}/model"),
            Some("{\"endpoint\":\"scripted\",\"model\":\"tiny\"}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_text(response).await;
        assert!(body.ends_with('\n'));
        let parsed: Value = serde_json::from_str(&body).expect("a JSON body");
        assert_eq!(parsed["endpoint"], "scripted");
        assert_eq!(parsed["model"], "tiny");
        let logged = logged.lock().expect("the switch log is not poisoned");
        assert_eq!(logged.len(), 1);
        assert_eq!(logged[0].0, SESSION);
        assert_eq!(logged[0].1.model.as_deref(), Some("tiny"));
    }
}
