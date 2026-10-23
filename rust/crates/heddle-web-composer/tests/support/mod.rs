//! What the integration test runs against: an in-memory host, a raw HTTP/1.1 client, and a **door double** — the
//! server's request path, reproduced in the order `heddle-server` applies it, so the composer's routes are judged
//! the way the binary will serve them rather than bare.
//!
//! # The door double, and where it comes from
//!
//! Read from `heddle-server` at developer-ten's `72fdb4f` (`src/server.rs`, `door` and `ServerBuilder::build`;
//! `src/fence.rs`; `src/token.rs`, `authorize`; `src/respond.rs`), which ports `handle` and `rejectUntrusted` of
//! `src/server/web.ts`. In that order:
//!
//! 1. **The fence** — a non-loopback `Host`, an `Origin` that is not a URL, or an `Origin` that is neither this
//!    authority nor loopback: `403`, plain text, before any credential is looked at.
//! 2. **The decision** — the cookie is checked first, then the `?token=` query against the launch token.
//! 3. **The cross-site write rule** — a request that changes state, **offered** a cookie, and was not authorized:
//!    `403` with the server's sentence. A request that offered no cookie falls through to step 4.
//! 4. **Unauthorized** — `401 unauthorized\n` for `/api…`.
//! 5. **The routes** — the server's own, then every mounted router merged after them (a path both claim is a
//!    start-up error, `ServerError::Route`, which is a caught panic of `Router::merge`), then `404 not found\n`
//!    for an unclaimed path **and** for a claimed path with the wrong method — the fallback sits inside the door.
//!
//! What the double does **not** reproduce, because no composer route meets it: the favicon and `/healthz`
//! answers, the `/?token=` handshake that mints the cookie, the page and its token form, and the cookie's HMAC.
//! The double accepts one fixed cookie value; how a cookie is minted and verified is the server's own test.
//!
//! The server's `/api/status`, steer and stop are served here from this crate's own modules, which carry the
//! TypeScript answers: D-039 gives those paths to the server, so they sit in the double's **core** routes and the
//! composer's [`heddle_web_composer::router`] is merged after them exactly as the binary's `mount_router` would.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use heddle_web_composer::context_view::{AssembleRequest, ContextAssembly, ContextHost, Surface};
use heddle_web_composer::model_switcher::{EndpointListing, ModelChoice, ModelHost};
use heddle_web_composer::session::SessionLookup;
use heddle_web_composer::status::StatusHost;
use heddle_web_composer::turn_control::TurnControlHost;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const SESSION: &str = "session-11111111-1111-4111-8111-111111111111";
pub const UNKNOWN: &str = "session-00000000-0000-4000-8000-000000000000";

/// The launch token the double accepts on `?token=`.
pub const LAUNCH_TOKEN: &str = "launch-token-for-the-door-double";
/// The cookie the double reads, and the one value it verifies.
pub const COOKIE_NAME: &str = "heddle-door-double";
pub const COOKIE_VALUE: &str = "minted-and-verified";
/// A cookie the double does not verify: offered, and stale.
pub const STALE_COOKIE: &str = "expired-or-forged";

/// The server's sentence for a refused cross-site write (`fence::CROSS_SITE_WRITE_REFUSAL`).
pub const CROSS_SITE_WRITE_REFUSAL: &str = "refused: a cross-site request that changes state and carries no valid session; a cross-site request may read, but writing requires the cookie this page was opened with\n";

/// `heddle-server`'s `CORE_ROUTES` at developer-ten's `72fdb4f`, copied so the disjointness the binary's start-up
/// depends on is asserted here too. If the server adds a route, this list is the one to update — the test that
/// reads it says which pair collided.
pub const SERVER_CORE_ROUTES: &[(&str, &str)] = &[
    ("GET", "/favicon.svg"),
    ("GET", "/favicon.ico"),
    ("GET", "/healthz"),
    ("GET", "/"),
    ("GET", "/api/events"),
    ("GET", "/api/status"),
    ("GET", "/api/sessions"),
    ("POST", "/api/sessions"),
    ("GET", "/api/sessions/{id}"),
    ("POST", "/api/sessions/{id}/fork"),
    ("POST", "/api/sessions/{id}/flags"),
    ("POST", "/api/sessions/{id}/title"),
    ("POST", "/api/sessions/{id}/permission"),
    ("POST", "/api/sessions/{id}/steer"),
    ("POST", "/api/sessions/{id}/stop"),
    ("POST", "/api/folders/session"),
    ("POST", "/api/turn"),
    ("GET", "/api/tree"),
    ("POST", "/api/workspaces"),
    ("PATCH", "/api/workspaces/{id}"),
    ("DELETE", "/api/workspaces/{id}"),
    ("GET", "/api/approvals"),
    ("POST", "/api/approvals/{id}"),
    ("GET", "/api/goal"),
    ("POST", "/api/goal"),
    ("GET", "/api/todo"),
    ("GET", "/api/team"),
    ("GET", "/api/html"),
    ("GET", "/vendor/purify.js"),
];

// ---------------------------------------------------------------------------------------------------------------
// The host: fixed answers, so the routes' statuses, sentences and shapes are what is judged.

#[derive(Clone, Default)]
pub struct Host;

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

// ---------------------------------------------------------------------------------------------------------------
// The door double.

/// Merge a mounted router the way `ServerBuilder::build` does: `Router::merge` panics on a path both routers claim
/// with the same method, and the server turns that panic into a start-up error rather than letting it unwind.
pub fn merge_mounted(router: Router, routes: Router, name: &str) -> Result<Router, String> {
    let merged =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || router.merge(routes)));
    merged.map_err(|payload| {
        let detail = payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| {
                payload
                    .downcast_ref::<&str>()
                    .map(|text| (*text).to_owned())
            })
            .unwrap_or_else(|| "two routers claim the same route".to_owned());
        format!("{name}: {detail}")
    })
}

/// The app as the binary will serve it: the server's core routes, the composer merged after them, the fallback for
/// unclaimed paths and wrong methods, and the door around all of it.
pub fn served(core: Router, mounted: Router) -> Result<Router, String> {
    let router = merge_mounted(core, mounted, "a mounted router")?;
    Ok(router
        .fallback(not_found)
        // web.ts has no method table: a known path with the wrong method is the same `404 not found`.
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn(door)))
}

/// The double's core: the three composer paths D-039 gives to the server, answered by this crate's modules.
pub fn server_core(host: Arc<Host>) -> Router {
    Router::new()
        .merge(heddle_web_composer::status::routes(Arc::clone(&host)))
        .merge(heddle_web_composer::turn_control::routes(host))
}

/// The composer served behind the door, as the binary will mount it.
pub fn served_composer() -> Router {
    let host = Arc::new(Host);
    served(
        server_core(Arc::clone(&host)),
        heddle_web_composer::router(host),
    )
    .expect("the composer mounts beside the server's routes")
}

async fn not_found() -> Response {
    text(StatusCode::NOT_FOUND, "not found\n")
}

/// `respond::text`: `text/plain`, `cache-control: no-store`.
fn text(status: StatusCode, body: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body.to_owned()))
        .expect("a response with static headers")
}

/// The door: fence, decision, cross-site write rule, unauthorized — then the routes.
async fn door(request: Request, next: Next) -> Response {
    let host_header = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let authority = host_header
        .clone()
        .unwrap_or_else(|| "127.0.0.1:0".to_owned());
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if let Some(refusal) = reject_untrusted(host_header.as_deref(), origin.as_deref(), &authority) {
        return text(StatusCode::FORBIDDEN, &format!("{refusal}\n"));
    }

    let cookie = request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(read_cookie)
        .map(str::to_owned);
    let token = request.uri().query().and_then(|query| {
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(key, _)| *key == "token")
            .map(|(_, value)| value.to_owned())
    });
    // `authorize`: the cookie first, then the launch token in the query.
    let authorized =
        cookie.as_deref() == Some(COOKIE_VALUE) || token.as_deref() == Some(LAUNCH_TOKEN);
    let changes_state = !matches!(*request.method(), Method::GET | Method::HEAD);
    if changes_state && cookie.is_some() && !authorized {
        return text(StatusCode::FORBIDDEN, CROSS_SITE_WRITE_REFUSAL);
    }
    if !authorized {
        if request.uri().path().starts_with("/api") {
            return text(StatusCode::UNAUTHORIZED, "unauthorized\n");
        }
        return text(StatusCode::UNAUTHORIZED, "the token form\n");
    }
    next.run(request).await
}

/// The cookie the double reads, by name, from a `Cookie` header.
fn read_cookie(header: &str) -> Option<&str> {
    header
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value)
}

/// `is_loopback`: the four names of this machine, exactly.
fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "::ffff:127.0.0.1")
}

/// `reject_untrusted`, for the hosts and origins the tests send (IPv6 literals are the server's own test).
fn reject_untrusted(host: Option<&str>, origin: Option<&str>, authority: &str) -> Option<String> {
    let host = host.unwrap_or("");
    let hostname = host.split(':').next().unwrap_or(host);
    if !host.is_empty() && !is_loopback(hostname) {
        return Some(format!("refused: Host {host} is not loopback"));
    }
    let origin = origin.filter(|origin| !origin.is_empty())?;
    let Some((scheme, rest)) = origin.split_once("://") else {
        return Some(format!("refused: Origin {origin} is not a URL"));
    };
    let origin_authority = rest
        .find(['/', '?', '#'])
        .map_or(rest, |end| &rest[..end])
        .to_ascii_lowercase();
    let (origin_hostname, port) = match origin_authority.rsplit_once(':') {
        Some((name, port)) => (name.to_owned(), Some(port.to_owned())),
        None => (origin_authority.clone(), None),
    };
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "http" => Some("80"),
        "https" => Some("443"),
        _ => None,
    };
    let origin_host = match port {
        Some(port) if Some(port.as_str()) != default_port => format!("{origin_hostname}:{port}"),
        _ => origin_hostname.clone(),
    };
    if origin_host != authority && !is_loopback(&origin_hostname) {
        return Some(format!("refused: Origin {origin} is not this machine"));
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------
// A listener, and a raw HTTP/1.1 client.

/// Serve `app` on a free loopback port.
pub async fn listen(app: Router) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a free port");
    let address = listener.local_addr().expect("an address");
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (address, server)
}

/// One answer over HTTP: status, headers and body.
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|_| panic!("a JSON body, not {:?}", self.body))
    }
}

/// The cookie header a page opened through the handshake would send.
pub fn session_cookie() -> (&'static str, String) {
    ("Cookie", format!("{COOKIE_NAME}={COOKIE_VALUE}"))
}

/// Speak HTTP/1.1, as the checks do through `fetch`. `Host` defaults to the listener's address unless a header in
/// `headers` names it.
///
/// The connection is kept alive and the answer is read by its `Content-Length`, never to end of stream. Measured
/// while writing the door tests: the door refuses a `POST` before reading its body, and with `Connection: close`
/// the server then closed a socket that still held the unread body, the kernel answered with a reset, and the
/// client lost the `401` it had been sent — a test that passed or failed by timing. Head and body also go out in
/// one write, so they reach the server together.
pub async fn send(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Option<&str>,
) -> Answer {
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("connected");
    let mut head = format!("{method} {path} HTTP/1.1\r\n");
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
    {
        head.push_str(&format!("Host: {address}\r\n"));
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        head.push_str("Content-Type: application/json\r\n");
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    } else if method != "GET" && method != "HEAD" {
        head.push_str("Content-Length: 0\r\n");
    }
    head.push_str("\r\n");
    let mut request = head.into_bytes();
    request.extend_from_slice(body.unwrap_or("").as_bytes());
    stream.write_all(&request).await.expect("written");

    // The head first, up to its blank line.
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        let read = stream.read(&mut chunk).await.expect("read");
        assert!(read > 0, "the connection closed before the answer's head");
        raw.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8(raw[..head_end].to_vec()).expect("a UTF-8 head");
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect();

    // Then exactly the body the head announced.
    let length: usize = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or_else(|| panic!("every answer here has a Content-Length; head: {head}"));
    let body_start = head_end + 4;
    while raw.len() < body_start + length {
        let read = stream.read(&mut chunk).await.expect("read");
        assert!(read > 0, "the connection closed before the answer's body");
        raw.extend_from_slice(&chunk[..read]);
    }
    let body =
        String::from_utf8(raw[body_start..body_start + length].to_vec()).expect("a UTF-8 body");
    Answer {
        status,
        headers,
        body,
    }
}

/// A request with the page's cookie, which is how the composer and context-view checks call these routes.
pub async fn authed(address: SocketAddr, method: &str, path: &str, body: Option<&str>) -> Answer {
    send(address, method, path, &[session_cookie()], body).await
}
