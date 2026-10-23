//! The four 80-web-ui checks' API expectations, as a regression test over a real listener.
//!
//! The checks themselves are browsers and a binary; this pins the part they read from the routes, so a change here
//! fails in the crate rather than in a check hours later. The host is a fixed in-memory double: the point is the
//! routes' statuses, sentences and body shapes, not the state behind them.
//!
//! The app below is the surface as it will be **served**: `router` mounts the three routes the composer owns, and
//! the three the server owns (`/api/status`, steer, stop) are mounted from this crate's modules, which still carry
//! their answers and tests. `router` alone mounts only the composer's three — `lib.rs` tests that the other three
//! are absent from it, which is what keeps the binary's mount from failing on an overlap.

use std::sync::Arc;

use heddle_web_composer::context_view::{AssembleRequest, ContextAssembly, ContextHost, Surface};
use heddle_web_composer::model_switcher::{EndpointListing, ModelChoice, ModelHost};
use heddle_web_composer::router;
use heddle_web_composer::session::SessionLookup;
use heddle_web_composer::status::StatusHost;
use heddle_web_composer::turn_control::TurnControlHost;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SESSION: &str = "session-11111111-1111-4111-8111-111111111111";
const UNKNOWN: &str = "session-00000000-0000-4000-8000-000000000000";

#[derive(Clone, Default)]
struct Host;

impl SessionLookup for Host {
    fn session_events(&self, id: &str) -> Option<Vec<Value>> {
        (id == SESSION).then(|| vec![json!({"type": "session/created", "seq": 1})])
    }
}

impl StatusHost for Host {
    fn sandbox_mode(&self) -> String {
        "workspace-write".to_owned()
    }

    fn workspace_root(&self) -> Option<String> {
        Some("/tmp/workspace".to_owned())
    }
}

impl ContextHost for Host {
    fn has_context(&self) -> bool {
        true
    }

    fn session_cwd(&self, _id: &str) -> String {
        "/tmp/workspace".to_owned()
    }

    fn assemble_context(&self, _id: &str, _request: &AssembleRequest) -> ContextAssembly {
        ContextAssembly {
            instructions: vec!["/tmp/workspace/AGENTS.md".to_owned()],
            estimated_tokens: 120,
            context_window: 128_000,
            threshold_tokens: 100_000,
            pruned: 0,
            compacted: false,
            messages: vec![],
        }
    }

    fn surface(&self, _id: &str) -> Surface {
        Surface {
            nodes: vec![],
            replacements: vec![],
        }
    }
}

impl ModelHost for Host {
    fn describe_endpoints(&self) -> EndpointListing {
        let mut entry = Map::new();
        entry.insert("name".to_owned(), json!("scripted"));
        entry.insert(
            "models".to_owned(),
            json!([{"id": "tiny", "contextWindow": 8192}]),
        );
        EndpointListing {
            endpoints: vec![entry],
            default: Some("scripted".to_owned()),
        }
    }

    async fn discover_context_window(&self, _endpoint: &str) -> Option<u64> {
        None
    }

    fn endpoint_names(&self) -> Vec<String> {
        vec!["scripted".to_owned()]
    }

    fn selection_problem(
        &self,
        _endpoint: &str,
        model: Option<&str>,
        _reasoning_effort: Option<&str>,
    ) -> Option<String> {
        (model == Some("nope")).then(|| "no model named 'nope'".to_owned())
    }

    fn set_session_model(&self, id: &str, choice: &ModelChoice) -> Option<Value> {
        (id == SESSION)
            .then(|| json!({"id": id, "endpoint": choice.endpoint, "model": choice.model}))
    }
}

impl TurnControlHost for Host {
    fn is_running(&self, _id: &str) -> bool {
        false
    }

    fn abort_session(&self, _id: &str) -> u64 {
        0
    }

    fn read_attachments(&self, _raw: Option<&Value>) -> Result<Vec<Value>, String> {
        Ok(vec![])
    }

    fn record_user_content(&self, _id: &str, _content: Vec<Value>) {}
}

/// One answer over HTTP: status, headers and body.
struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).expect("a JSON body")
    }
}

/// Speak HTTP/1.1 to the listener, as the checks do through fetch.
async fn request(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Answer {
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connected");
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    if let Some(body) = body {
        head.push_str("Content-Type: application/json\r\n");
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.expect("written");
    if let Some(body) = body {
        stream.write_all(body.as_bytes()).await.expect("written");
    }
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let text = String::from_utf8(raw).expect("a UTF-8 answer");
    let (head, body) = text.split_once("\r\n\r\n").expect("a header block");
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect();
    Answer {
        status,
        headers,
        body: body.to_owned(),
    }
}

#[tokio::test]
async fn the_four_checks_api_expectations_hold_over_a_listener() {
    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .merge(router(Arc::new(Host)))
        // The server's three, served from this crate's modules here so the whole contract is judged together.
        .merge(heddle_web_composer::status::routes(Arc::new(Host)))
        .merge(heddle_web_composer::turn_control::routes(Arc::new(Host)));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a free port");
    let address = listener.local_addr().expect("an address");
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // composer: the access chip reads the deployment mode and the root after the page boots.
    let status = request(address, "GET", "/api/status", None).await;
    assert_eq!(status.status, 200);
    assert_eq!(status.header("cache-control"), Some("no-store"));
    assert_eq!(
        status.json(),
        json!({"sandbox": {"mode": "workspace-write"}, "cwd": "/tmp/workspace"})
    );
    assert!(
        !status.body.contains("\n  "),
        "status is compact, as JSON.stringify without an indent: {}",
        status.body
    );

    // context-view: no session is refused, an unknown one is not invented, a known one carries the composition.
    let missing = request(address, "GET", "/api/context", None).await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.json()["error"], "a session is required");
    let unknown = request(
        address,
        "GET",
        &format!("/api/context?session={UNKNOWN}"),
        None,
    )
    .await;
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.json()["error"], format!("no session {UNKNOWN}"));
    let composed = request(
        address,
        "GET",
        &format!("/api/context?session={SESSION}"),
        None,
    )
    .await;
    assert_eq!(composed.status, 200);
    let report = composed.json();
    assert_eq!(report["session"], SESSION);
    assert_eq!(report["instructions"], json!(["/tmp/workspace/AGENTS.md"]));
    assert_eq!(report["estimatedTokens"], 120);
    assert_eq!(report["contextWindow"], 128_000);
    assert_eq!(report["thresholdTokens"], 100_000);
    assert_eq!(report["surface"], json!({"nodes": [], "replacements": []}));
    assert_eq!(
        report["endpoint"],
        Value::Null,
        "an unasked endpoint is null"
    );
    assert!(report["compacted"].is_boolean());
    assert!(composed.body.contains("\n  "), "the context view is pretty");

    // model-switcher: the list, and the switch validated in the TypeScript order.
    let endpoints = request(address, "GET", "/api/endpoints", None).await;
    assert_eq!(endpoints.status, 200);
    let listing = endpoints.json();
    assert_eq!(listing["default"], "scripted");
    assert_eq!(listing["endpoints"][0]["name"], "scripted");
    assert!(endpoints.body.contains("\n  "), "the list is pretty");

    let malformed = request(
        address,
        "POST",
        "/api/sessions/not-a-session/model",
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(malformed.status, 400);
    assert_eq!(malformed.json()["error"], "not a session id");
    let unconfigured = request(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        Some(r#"{"endpoint":"nope"}"#),
    )
    .await;
    assert_eq!(unconfigured.status, 400);
    assert!(
        unconfigured.json()["error"]
            .as_str()
            .expect("a sentence")
            .starts_with("no endpoint named 'nope'")
    );
    let undeclared = request(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        Some(r#"{"endpoint":"scripted","model":"nope"}"#),
    )
    .await;
    assert_eq!(undeclared.status, 400);
    assert_eq!(undeclared.json()["error"], "no model named 'nope'");
    let switched = request(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(switched.status, 200);
    assert_eq!(switched.json()["endpoint"], "scripted");

    // composer: a steer's refusals, with the prompt decided before what is running.
    let steer_malformed = request(
        address,
        "POST",
        "/api/sessions/not-a-session/steer",
        Some(r#"{"prompt":"x"}"#),
    )
    .await;
    assert_eq!(steer_malformed.status, 400);
    assert_eq!(steer_malformed.json()["error"], "not a session id");
    let steer_blank = request(
        address,
        "POST",
        &format!("/api/sessions/{UNKNOWN}/steer"),
        Some(r#"{"prompt":"   "}"#),
    )
    .await;
    assert_eq!(steer_blank.status, 400);
    assert_eq!(steer_blank.json()["error"], "a prompt is required");
    let steer_unavailable = request(
        address,
        "POST",
        &format!("/api/sessions/{UNKNOWN}/steer"),
        Some(r#"{"prompt":"nobody is running"}"#),
    )
    .await;
    assert_eq!(steer_unavailable.status, 409);
    assert_eq!(
        steer_unavailable.json()["code"],
        "session/steer-unavailable"
    );

    // composer: stopping answers what it stopped, and zero is not an error.
    let stopped = request(
        address,
        "POST",
        &format!("/api/sessions/{UNKNOWN}/stop"),
        None,
    )
    .await;
    assert_eq!(stopped.status, 200);
    assert_eq!(stopped.json(), json!({"stopped": 0, "session": UNKNOWN}));

    server.abort();
}
