//! The doubles the composer's route tests run against.
//!
//! The crate owns routes, not state, so every route is judged against a host that answers from memory: the
//! session store, the context assembler, the model service and the turn registry are all replaced by fields a
//! test sets. That is the same seam the server uses, so a route that passes here has been judged where it will
//! run.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, header};
use axum::response::Response;
use serde_json::Value;
use tower::ServiceExt;

use crate::context_view::{AssembleRequest, ContextAssembly, ContextHost, Surface};
use crate::model_switcher::{EndpointListing, ModelChoice, ModelHost};
use crate::session::SessionLookup;
use crate::status::StatusHost;
use crate::turn_control::TurnControlHost;

/// The steers a host recorded, and the model switches it was asked for.
pub type RecordLog = Arc<Mutex<Vec<(String, Vec<Value>)>>>;
pub type SwitchLog = Arc<Mutex<Vec<(String, ModelChoice)>>>;

/// A host that answers every composer question from fields a test sets.
#[derive(Clone)]
pub struct Host {
    pub sessions: HashMap<String, Vec<Value>>,
    pub sandbox_mode: String,
    pub workspace_root: Option<String>,
    pub has_context: bool,
    pub cwd: String,
    pub assembly: ContextAssembly,
    pub surface: Surface,
    pub endpoints: EndpointListing,
    pub names: Vec<String>,
    pub discovered: HashMap<String, Option<u64>>,
    pub selection_problem: Option<String>,
    pub running: bool,
    pub aborted: u64,
    pub attachment_error: Option<String>,
    pub recorded: RecordLog,
    pub switched: SwitchLog,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            sandbox_mode: "workspace-write".to_owned(),
            workspace_root: Some("/tmp/workspace".to_owned()),
            has_context: true,
            cwd: "/tmp/workspace".to_owned(),
            assembly: ContextAssembly::default(),
            surface: Surface::default(),
            endpoints: EndpointListing::default(),
            names: vec!["scripted".to_owned()],
            discovered: HashMap::new(),
            selection_problem: None,
            running: false,
            aborted: 0,
            attachment_error: None,
            recorded: Arc::new(Mutex::new(Vec::new())),
            switched: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl Host {
    /// A host that holds one session with `events`.
    pub fn with_session(id: &str, events: Vec<Value>) -> Self {
        let mut host = Self::default();
        host.sessions.insert(id.to_owned(), events);
        host
    }
}

impl SessionLookup for Host {
    fn session_events(&self, id: &str) -> Option<Vec<Value>> {
        self.sessions.get(id).cloned()
    }
}

impl StatusHost for Host {
    fn sandbox_mode(&self) -> String {
        self.sandbox_mode.clone()
    }

    fn workspace_root(&self) -> Option<String> {
        self.workspace_root.clone()
    }
}

impl ContextHost for Host {
    fn has_context(&self) -> bool {
        self.has_context
    }

    fn session_cwd(&self, _id: &str) -> String {
        self.cwd.clone()
    }

    fn assemble_context(&self, _id: &str, _request: &AssembleRequest) -> ContextAssembly {
        self.assembly.clone()
    }

    fn surface(&self, _id: &str) -> Surface {
        self.surface.clone()
    }
}

impl ModelHost for Host {
    fn describe_endpoints(&self) -> EndpointListing {
        self.endpoints.clone()
    }

    fn discover_context_window(&self, endpoint: &str) -> impl Future<Output = Option<u64>> + Send {
        let value = self.discovered.get(endpoint).copied().flatten();
        async move { value }
    }

    fn endpoint_names(&self) -> Vec<String> {
        self.names.clone()
    }

    fn selection_problem(
        &self,
        _endpoint: &str,
        _model: Option<&str>,
        _reasoning_effort: Option<&str>,
    ) -> Option<String> {
        self.selection_problem.clone()
    }

    fn set_session_model(&self, id: &str, choice: &ModelChoice) -> Option<Value> {
        if !self.sessions.contains_key(id) {
            return None;
        }
        self.switched
            .lock()
            .expect("the switch log is not poisoned")
            .push((id.to_owned(), choice.clone()));
        Some(serde_json::json!({
            "id": id,
            "endpoint": choice.endpoint,
            "model": choice.model,
        }))
    }
}

impl TurnControlHost for Host {
    fn is_running(&self, _id: &str) -> bool {
        self.running
    }

    fn abort_session(&self, _id: &str) -> u64 {
        self.aborted
    }

    fn read_attachments(&self, raw: Option<&Value>) -> Result<Vec<Value>, String> {
        if let Some(message) = self.attachment_error.clone() {
            return Err(message);
        }
        Ok(raw
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .map(|part| serde_json::json!({"type": "image", "name": part}))
                    .collect()
            })
            .unwrap_or_default())
    }

    fn record_user_content(&self, id: &str, content: Vec<Value>) {
        self.recorded
            .lock()
            .expect("the record log is not poisoned")
            .push((id.to_owned(), content));
    }
}

/// Read a response body as text.
pub async fn body_text(response: Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .expect("the body fits");
    String::from_utf8(bytes.to_vec()).expect("a UTF-8 body")
}

/// Send one request through a router, the way the server's handler would.
pub async fn call(router: Router, method: Method, uri: &str, body: Option<&str>) -> Response {
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_owned())
        }
        None => Body::empty(),
    };
    router
        .oneshot(request.body(body).expect("a valid request"))
        .await
        .expect("the router answers")
}

/// Assert the two headers every answer carries.
pub fn assert_answer_headers(response: &Response, content_type: &str) {
    assert_eq!(response.headers()[header::CONTENT_TYPE], content_type);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
}
