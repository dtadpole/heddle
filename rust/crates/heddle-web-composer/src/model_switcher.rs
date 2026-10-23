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

use serde::Serialize;
use serde_json::{Map, Value};

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
    listing: EndpointListing,
    discovered: &[Option<u64>],
) -> EndpointListing {
    let _ = (listing, discovered);
    todo!("with_discovered_windows")
}

/// Validate a switch body against the model service, in the TypeScript route's order: endpoint required, then
/// configured, then the model and effort declared. `Err` is the sentence of the `400`.
pub fn validate_model_switch<H: ModelHost + ?Sized>(
    host: &H,
    body: &Map<String, Value>,
) -> Result<ModelChoice, String> {
    let _ = (host, body);
    todo!("validate_model_switch")
}

/// `GET /api/endpoints` and `POST /api/sessions/{id}/model`.
pub fn routes<H: ModelHost>(host: Arc<H>) -> axum::Router {
    let _ = host;
    todo!("model_switcher::routes")
}
