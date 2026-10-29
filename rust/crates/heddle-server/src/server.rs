//! The server: options, the builder feature crates mount into, the shared state, and the running server.
//!
//! # A request's path
//!
//! In the order `handle` in `src/server/web.ts` takes it, which is the order the verifiers judge:
//!
//! 1. **The fence** ([`crate::fence::reject_untrusted`]) — `403` in plain text, before any secret.
//! 2. **`/favicon.svg`, `/favicon.ico`, `/healthz`** — answered without a token, and carrying nothing
//!    private: `{"ok":true,"service":"heddle-web","port":<bound port>}`.
//! 3. **The handshake** — `/?token=<launch token>` answers `303` to `/` with the cookie, `no-store` and
//!    `no-referrer`; a wrong token gets the token form, `401`, marked stale.
//! 4. **The decision** ([`crate::token::authorize`]), and the cross-site write rule.
//! 5. **`GET /`** — the page with a session, else the token form (`401`), stale when a cookie was offered.
//! 6. **Unauthorized** — `401 unauthorized` for `/api…`, the token form otherwise.
//! 7. **The routes** — this crate's ([`CORE_ROUTES`]) and every mounted [`Feature`]'s; `404 not found`
//!    when none claims the request.
//!
//! Steps 1–6 are one middleware around the whole router, fallback included, so a feature's routes are
//! fenced and authenticated without the feature doing anything.
//!
//! # Mounting a feature
//!
//! A feature crate that answers through the shared [`AppState`] implements [`Feature`]; one that
//! applies its own state (a `Router<()>`, like `heddle-web-files`'s `FilesRoutes::router`) is handed to
//! [`ServerBuilder::mount_router`]. Either way the fence and the token wrap it. A crate that implements
//! [`Feature`] is mounted by the binary:
//!
//! ```ignore
//! let server = ServerBuilder::new(harness, options)
//!     .mount(heddle_web_files::FilesFeature::new(..))
//!     .mount(heddle_web_composer::ComposerFeature::new(..))
//!     .session_view("ledger", Arc::new(heddle_web_trajectory::LedgerView::new(..)))
//!     .start()
//!     .await?;
//! ```
//!
//! A feature's handlers take `State<AppState>` for what every route shares (the [`Harness`], the
//! [`EventHub`], the [`RunRegistry`]) and keep anything of their own in their `Feature` value, captured by
//! the router they return. Paths under `/api/sessions/` name the session segment `{id}`
//! ([`crate::respond::SessionPath`]). Two routers claiming the same method and path is a build error
//! ([`ServerError::Route`]), found at startup rather than as a route silently shadowed.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{Method, StatusCode, header::HOST};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{delete, get, patch, post};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::fence;
use crate::page;
use crate::preview;
use crate::respond::{self, JsonBody, SessionId, SessionPath, canonical_path};
use crate::runs::{RunRegistry, iso_time};
use crate::selection::{SessionSelection, session_request_selection, turn_selection};
use crate::services::{
    ApprovalOutcome, FlagPatch, ForkOutcome, GoalAction, GoalAnswer, GoalRef, Harness, OpenAt,
    ServiceError, SessionMeta, StartSession,
};
use crate::stream::{self, EventHub, SseFrame, names, sse_response};
use crate::token::{
    self, Credentials, Door, TOKEN_QUERY, cookie_header, cookie_name, mint_cookie, read_cookie,
};

/// The default port: 3080 is `dsh web` and 3081 a relay on the machine this was developed on.
pub const DEFAULT_PORT: u16 = 3082;
/// The default host. Anything that is not loopback is refused.
pub const DEFAULT_HOST: &str = "127.0.0.1";
/// The service name `/healthz` reports.
pub const SERVICE_NAME: &str = "heddle-web";

/// The routes this crate serves itself, as `(method, axum path)`. Everything else in `src/server/web.ts`
/// is mounted by a feature crate; the crate's `INDEX.md` has the whole table with owners.
pub const CORE_ROUTES: &[(&str, &str)] = &[
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
    ("GET", "/api/workspaces"),
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

/// How the server is started — the flags of `heddle web` that reach it.
#[derive(Debug, Clone, Default)]
pub struct ServerOptions {
    /// `--host`; [`DEFAULT_HOST`] when absent. Anything not loopback is refused at start.
    pub host: Option<String>,
    /// `--port`; [`DEFAULT_PORT`] when absent, and `0` asks the system for a free port.
    pub port: Option<u16>,
    /// `--max-rounds`: rounds one interactive turn may take; unbounded when absent, which is DSH's rule.
    pub max_rounds: Option<u32>,
    /// Where the cookie-signing secret lives; [`crate::token::default_secret_path`] when absent.
    pub secret_path: Option<PathBuf>,
    /// The launch token; generated when absent, which is the normal case.
    pub token: Option<String>,
    /// `--endpoint`: the endpoint a turn uses when neither the request nor the session names one.
    pub default_endpoint: Option<String>,
    /// Installation roots searched for `node_modules/dompurify` ([`crate::preview::purify_path`]).
    pub asset_roots: Vec<PathBuf>,
}

impl ServerOptions {
    /// The host the server binds.
    pub fn host(&self) -> &str {
        self.host.as_deref().unwrap_or(DEFAULT_HOST)
    }

    /// The port the server asks for (`0` is "any").
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_PORT)
    }
}

/// The launch URL: `http://<host>:<port>/?token=<token>`.
pub fn launch_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{host}:{port}/?{TOKEN_QUERY}={token}")
}

/// What `heddle web --dry-run --json` prints: the plan, without binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunPlan {
    /// The URL it would print, with the placeholder `token=generated-at-start`.
    pub url: String,
    pub host: String,
    pub port: u16,
    pub dry_run: bool,
}

impl DryRunPlan {
    /// The plan for these options: the chosen host and port, nothing bound.
    pub fn for_options(options: &ServerOptions) -> Self {
        let host = options.host().to_owned();
        let port = options.port();
        DryRunPlan {
            url: launch_url(&host, port, "generated-at-start"),
            host,
            port,
            dry_run: true,
        }
    }

    /// `heddle web: would serve <url>`.
    pub fn announce(&self) -> String {
        format!("heddle web: would serve {}", self.url)
    }
}

/// Why the server could not be built or started.
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    /// A non-loopback host, with the TypeScript build's sentence.
    #[error("{0}")]
    NotLoopback(String),
    /// The signing secret could not be read or created.
    #[error("the signing secret at {path}: {source}")]
    Secret {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The socket could not be bound.
    #[error("cannot listen on {address}: {source}")]
    Bind {
        address: String,
        #[source]
        source: std::io::Error,
    },
    /// Two routers claim the same route, or a feature named the session segment differently.
    #[error("route conflict: {0}")]
    Route(String),
}

/// A set of routes a feature crate contributes. Mounted behind the fence and the token.
pub trait Feature: Send + Sync + 'static {
    /// A short name for logs and conflict reports, e.g. `"files"`.
    fn name(&self) -> &'static str;

    /// The routes, as paths under the server root.
    fn routes(&self) -> Router<AppState>;
}

/// An alternative projection of one session, served by `GET /api/sessions/{id}?view=<name>` — how the
/// trajectory crate serves the ledger from the same route as the chat view, so the two views are
/// projections of one read and cannot disagree.
pub trait SessionView: Send + Sync + 'static {
    /// The whole response for this view of the session's events. The session exists; its id is valid.
    fn respond(&self, state: &AppState, session: &SessionId, events: &[Value]) -> Response;
}

/// What every route shares. Cheap to clone.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Shared>,
}

struct Shared {
    harness: Harness,
    events: EventHub,
    runs: RunRegistry,
    options: ServerOptions,
    views: BTreeMap<String, Arc<dyn SessionView>>,
    launch_token: String,
    secret: String,
    port: u16,
}

impl AppState {
    pub fn harness(&self) -> &Harness {
        &self.inner.harness
    }

    pub fn events(&self) -> &EventHub {
        &self.inner.events
    }

    pub fn runs(&self) -> &RunRegistry {
        &self.inner.runs
    }

    pub fn options(&self) -> &ServerOptions {
        &self.inner.options
    }

    /// The port the server is bound to (the real one when `0` was asked for).
    pub fn port(&self) -> u16 {
        self.inner.port
    }

    /// The host the server is bound to.
    pub fn host(&self) -> &str {
        self.inner.options.host()
    }

    /// A registered session view by name.
    pub fn session_view(&self, name: &str) -> Option<Arc<dyn SessionView>> {
        self.inner.views.get(name).cloned()
    }
}

/// Assembles a server from a harness, options, features and session views.
pub struct ServerBuilder {
    harness: Harness,
    options: ServerOptions,
    events: EventHub,
    runs: RunRegistry,
    features: Vec<Box<dyn Feature>>,
    routers: Vec<Router<()>>,
    views: BTreeMap<String, Arc<dyn SessionView>>,
}

impl ServerBuilder {
    pub fn new(harness: Harness, options: ServerOptions) -> Self {
        ServerBuilder {
            harness,
            options,
            events: EventHub::new(),
            runs: RunRegistry::new(),
            features: Vec::new(),
            routers: Vec::new(),
            views: BTreeMap::new(),
        }
    }

    /// The hub the server will stream from, so the binary can bridge the event bus into it before start.
    pub fn events(&self) -> EventHub {
        self.events.clone()
    }

    /// Stream from a hub the binary created first.
    ///
    /// The session store takes its event listener when it is built, which is before the harness and
    /// so before this builder exists. Create the hub, give the store
    /// [`crate::adapters::session_event_listener`] over it, then hand the same hub here.
    pub fn with_event_hub(mut self, hub: EventHub) -> Self {
        self.events = hub;
        self
    }

    /// The run registry, shared with anything that needs to know which sessions are running.
    pub fn runs(&self) -> RunRegistry {
        self.runs.clone()
    }

    /// Mount a feature's routes.
    pub fn mount(mut self, feature: impl Feature) -> Self {
        self.features.push(Box::new(feature));
        self
    }

    /// Mount a router whose state is already applied, `Router<()>`.
    ///
    /// This is the shape a ui-lane crate produces when it builds its handlers over its own state
    /// (`FilesRoutes::router()` in `heddle-web-files`); it is merged after the server's state is
    /// applied, so the two routers share one type. It is behind the same fence and token as a
    /// [`Feature`], and a route conflict with the core routes is still [`ServerError::Route`].
    pub fn mount_router(mut self, router: Router<()>) -> Self {
        self.routers.push(router);
        self
    }

    /// Register a `?view=<name>` projection of `GET /api/sessions/{id}`.
    pub fn session_view(mut self, name: impl Into<String>, view: Arc<dyn SessionView>) -> Self {
        self.views.insert(name.into(), view);
        self
    }

    /// The router and its state without a socket, for tests that drive it with `tower::ServiceExt`.
    /// `port` stands in for the bound port; the secret is read from (or created at) the options' path.
    pub fn into_router(self, port: u16) -> Result<(Router, AppState), ServerError> {
        let host = self.options.host();
        if !fence::is_loopback(host) {
            return Err(ServerError::NotLoopback(fence::bind_refusal(host)));
        }
        let secret_path = self
            .options
            .secret_path
            .clone()
            .unwrap_or_else(token::default_secret_path);
        let secret =
            token::read_or_create_secret(&secret_path).map_err(|source| ServerError::Secret {
                path: secret_path.clone(),
                source,
            })?;
        let launch_token = self
            .options
            .token
            .clone()
            .unwrap_or_else(token::create_launch_token);
        let state = AppState {
            inner: Arc::new(Shared {
                harness: self.harness,
                events: self.events,
                runs: self.runs,
                options: self.options,
                views: self.views,
                launch_token,
                secret,
                port,
            }),
        };

        let mut router = Router::new()
            .route("/favicon.svg", get(favicon))
            .route("/favicon.ico", get(favicon))
            .route("/healthz", get(healthz))
            .route("/", get(page_route))
            .route("/api/events", get(events_route))
            .route("/api/status", get(status))
            .route("/api/sessions", get(list_sessions).post(create_session))
            .route("/api/sessions/{id}", get(session_view_route))
            .route("/api/sessions/{id}/fork", post(fork_session))
            .route("/api/sessions/{id}/flags", post(flags_session))
            .route("/api/sessions/{id}/title", post(title_session))
            .route("/api/sessions/{id}/permission", post(permission_session))
            .route("/api/sessions/{id}/steer", post(steer_session))
            .route("/api/sessions/{id}/stop", post(stop_session))
            .route("/api/folders/session", post(folder_session))
            .route("/api/turn", post(turn))
            .route("/api/tree", get(tree))
            .route("/api/workspaces", get(list_workspaces).post(add_workspace))
            .route("/api/workspaces/{id}", patch(rename_workspace))
            .route("/api/workspaces/{id}", delete(remove_workspace))
            .route("/api/approvals", get(list_approvals))
            .route("/api/approvals/{id}", post(answer_approval))
            .route("/api/goal", get(get_goal).post(post_goal))
            .route("/api/todo", get(get_todo))
            .route("/api/team", get(get_team))
            .route("/api/html", get(html_preview))
            .route("/vendor/purify.js", get(purify));
        for feature in self.features {
            let name = feature.name();
            let routes = feature.routes();
            router = merge_mounted(router, routes, &format!("the {name} feature"))?;
        }
        // The state is applied first, so a ui-lane crate's state-applied `Router<()>` can be merged
        // into the same router type. The door layer still carries `AppState` itself.
        let mut router = router.with_state(state.clone());
        for routes in self.routers {
            router = merge_mounted(router, routes, "a mounted router")?;
        }
        let router = router
            .fallback(fallback_route)
            // web.ts has no method table: a request whose path matches but whose method does not
            // falls through to the same `404 not found`, so a wrong method is not a 405 here either.
            .method_not_allowed_fallback(fallback_route)
            .layer(middleware::from_fn_with_state(state.clone(), door))
            .layer(middleware::from_fn(catch_panics));
        Ok((router, state))
    }

    /// Refuse a non-loopback host, read the secret, mint the token, bind, and serve in the background.
    /// Returns once the socket is listening, so the caller can print the URL without racing it.
    pub async fn start(self) -> Result<WebServer, ServerError> {
        let host = self.options.host().to_owned();
        // The host is judged before a socket is opened, so the refusal cannot leave one behind.
        if !fence::is_loopback(&host) {
            return Err(ServerError::NotLoopback(fence::bind_refusal(&host)));
        }
        let requested_port = self.options.port();
        let address = format!("{host}:{requested_port}");
        let listener = tokio::net::TcpListener::bind((host.as_str(), requested_port))
            .await
            .map_err(|source| ServerError::Bind {
                address: address.clone(),
                source,
            })?;
        let port = listener
            .local_addr()
            .map(|local| local.port())
            .unwrap_or(requested_port);
        // The state carries the real port, because `/healthz` and the cookie authority judge it.
        let (router, state) = self.into_router(port)?;
        // While this server runs it is the surface that answers approval questions; attaching is
        // what turns an `ask` policy from "nobody can answer, so deny" into a card a person answers.
        let detach_approvals = state
            .harness()
            .approvals
            .as_ref()
            .map(|approvals| approvals.attach_answerer());
        // A service that publishes its questions itself is relayed here, so a card reaches every
        // `/api/events` subscriber as an `approval` frame without the binary wiring a listener.
        let approval_relay = state
            .harness()
            .approvals
            .as_ref()
            .and_then(|approvals| approvals.subscribe())
            .map(|mut questions| {
                let hub = state.events().clone();
                tokio::spawn(async move {
                    use futures::StreamExt;
                    while let Some(question) = questions.next().await {
                        hub.publish_approval_request(&question);
                    }
                })
            });
        // The heartbeat: every interval each `/api/events` subscriber gets a `heartbeat` frame, and a connection
        // whose writes stay pending for two intervals is closed (DSH's dead-peer rule, `stall.rs`).
        let interval = stream::heartbeat_interval();
        let heartbeat = {
            let hub = state.events().clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(interval);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    hub.publish(SseFrame::heartbeat());
                }
            })
        };
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let listener = crate::stall::GuardedListener::new(without_nagle(listener), interval * 2);
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        let token = state.inner.launch_token.clone();
        Ok(WebServer {
            url: launch_url(&host, port, &token),
            token,
            host,
            port,
            state,
            shutdown: Some(shutdown_tx),
            task: Some(task),
            detach_approvals,
            approval_relay,
            heartbeat: Some(heartbeat),
        })
    }
}

/// A listening server.
pub struct WebServer {
    url: String,
    token: String,
    host: String,
    port: u16,
    state: AppState,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
    /// The approval service's detach function, held for as long as the server answers questions.
    detach_approvals: Option<Box<dyn FnOnce() + Send>>,
    /// The task relaying the approval service's published questions into the hub.
    approval_relay: Option<tokio::task::JoinHandle<()>>,
    /// The task writing a heartbeat to every stream once per interval.
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}

impl WebServer {
    /// `http://<host>:<port>/?token=<token>`.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    /// The bound port.
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// The two lines `heddle web` prints once listening:
    /// `heddle web: <url>` and `heddle web: serving on <host>:<port>; pass --port to change it`.
    /// The verifiers wait for the first.
    pub fn announce(&self) -> [String; 2] {
        [
            format!("heddle web: {}", self.url),
            format!(
                "heddle web: serving on {}:{}; pass --port to change it",
                self.host, self.port
            ),
        ]
    }

    /// What `--json` adds: `{"url","host","port","token"}` on one line.
    pub fn announce_json(&self) -> String {
        format!(
            "{{\"url\":{},\"host\":{},\"port\":{},\"token\":{}}}",
            serde_json::to_string(&self.url).expect("a string serializes"),
            serde_json::to_string(&self.host).expect("a string serializes"),
            self.port,
            serde_json::to_string(&self.token).expect("a string serializes")
        )
    }

    /// Stop, streams and all: detach the approval answerer, end every stream subscriber, stop accepting,
    /// and close the connections that remain — an event stream is open by design, so waiting for it to
    /// end on its own would never return.
    pub async fn close(mut self) {
        if let Some(detach) = self.detach_approvals.take() {
            detach();
        }
        if let Some(relay) = self.approval_relay.take() {
            relay.abort();
        }
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
        self.state.events().close();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            // A graceful shutdown waits for open connections; an event stream never ends on its own, so the
            // task is aborted after the subscribers were ended. The listener and its socket are closed with it.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if !task.is_finished() {
                task.abort();
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Mounting

/// Merge one mounted router, turning `Router::merge`'s route-conflict panic into [`ServerError::Route`].
///
/// A router is a whole set of routes, so a duplicate method+path is only discoverable at merge time;
/// the contract promises a startup error naming the mount rather than a panic or a shadowed route.
fn merge_mounted<S>(
    router: Router<S>,
    routes: Router<S>,
    name: &str,
) -> Result<Router<S>, ServerError>
where
    S: Clone + Send + Sync + 'static,
{
    let merged =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || router.merge(routes)));
    match merged {
        Ok(merged) => Ok(merged),
        Err(payload) => {
            let detail = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| {
                    payload
                        .downcast_ref::<&str>()
                        .map(|text| (*text).to_owned())
                })
                .unwrap_or_else(|| "two routers claim the same route".to_owned());
            Err(ServerError::Route(format!("{name}: {detail}")))
        }
    }
}

/// A handler that panics answers `500 internal error: <message>` instead of dropping the connection.
///
/// web.ts wraps every request in a catch for the same reason: a route that throws must not take the
/// connection (or the next check, which then reports "fetch failed" about the wrong thing) with it.
/// Outermost, so the door and every mounted feature are covered.
async fn catch_panics(request: Request, next: Next) -> Response {
    use futures::FutureExt;
    match std::panic::AssertUnwindSafe(next.run(request))
        .catch_unwind()
        .await
    {
        Ok(response) => response,
        Err(payload) => {
            let message = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| {
                    payload
                        .downcast_ref::<&str>()
                        .map(|text| (*text).to_owned())
                })
                .unwrap_or_else(|| "the route failed".to_owned());
            respond::internal_error(message)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// The door: fence, favicon/healthz, handshake, decision, page, unauthorized

async fn door(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let authority = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}:{}", state.host(), state.port()));
    let host_header = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if let Some(refusal) =
        fence::reject_untrusted(host_header.as_deref(), origin.as_deref(), &authority)
    {
        return respond::text(StatusCode::FORBIDDEN, format!("{refusal}\n"));
    }

    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    if method == Method::GET && (path == "/favicon.svg" || path == "/favicon.ico") {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "image/svg+xml")
            .header("content-length", page::FAVICON_SVG.len().to_string())
            .header("cache-control", "no-store")
            .body(Body::from(page::FAVICON_SVG))
            .expect("a response builder with static headers");
    }
    if method == Method::GET && path == "/healthz" {
        return healthz_body(state.port());
    }

    let query = parse_query(request.uri().query());
    if path == "/" && query.contains_key(TOKEN_QUERY) {
        let presented = query.get(TOKEN_QUERY).map(String::as_str).unwrap_or("");
        if !token::safe_equal(presented, &state.inner.launch_token) {
            return respond::html(StatusCode::UNAUTHORIZED, page::token_form_page(true));
        }
        let value = mint_cookie(&state.inner.secret, &authority, token::now_ms());
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header("location", "/")
            .header(
                "set-cookie",
                cookie_header(&authority, &value, token::COOKIE_MAX_AGE),
            )
            .header("cache-control", "no-store")
            .header("referrer-policy", "no-referrer")
            .body(Body::empty())
            .expect("a response builder with static headers");
    }

    let credentials = Credentials {
        cookie: read_cookie(
            request
                .headers()
                .get("cookie")
                .and_then(|value| value.to_str().ok()),
            &cookie_name(&authority),
        ),
        query: query.get(TOKEN_QUERY).map(String::as_str),
    };
    let decision = token::authorize(
        &credentials,
        &Door {
            launch_token: &state.inner.launch_token,
            secret: &state.inner.secret,
            authority: &authority,
            now_ms: token::now_ms(),
        },
    );
    let offered = credentials.offered();
    if fence::refuse_cross_site_write(&method, offered.cookie, decision.is_ok()) {
        return respond::text(StatusCode::FORBIDDEN, fence::CROSS_SITE_WRITE_REFUSAL);
    }

    if path == "/" && method == Method::GET {
        let access = page::page_access(decision.is_ok(), offered.cookie);
        if access.status == 200 {
            return respond::html(StatusCode::OK, page::page());
        }
        return respond::html(
            StatusCode::UNAUTHORIZED,
            page::token_form_page(access.stale),
        );
    }

    if !decision.is_ok() {
        if path.starts_with("/api") {
            return respond::unauthorized();
        }
        return respond::html(StatusCode::UNAUTHORIZED, page::token_form_page(false));
    }

    next.run(request).await
}

/// A query string as `URLSearchParams` reads it: percent-decoded, `+` as a space, the first value winning.
fn parse_query(query: Option<&str>) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Some(query) = query else {
        return values;
    };
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        values
            .entry(decode_component(key))
            .or_insert_with(|| decode_component(value));
    }
    values
}

/// Percent-decode one query component, with `+` read as a space.
fn decode_component(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------------------------------------
// The core routes

async fn fallback_route() -> Response {
    respond::not_found()
}

async fn favicon() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "image/svg+xml")
        .header("content-length", page::FAVICON_SVG.len().to_string())
        .header("cache-control", "no-store")
        .body(Body::from(page::FAVICON_SVG))
        .expect("a response builder with static headers")
}

/// `/healthz`'s answer, in the TypeScript key order: `ok`, `service`, `port`.
#[derive(Serialize)]
struct Healthz {
    ok: bool,
    service: &'static str,
    port: u16,
}

fn healthz_body(port: u16) -> Response {
    respond::json_compact(
        StatusCode::OK,
        &Healthz {
            ok: true,
            service: SERVICE_NAME,
            port,
        },
    )
}

async fn healthz(State(state): State<AppState>) -> Response {
    healthz_body(state.port())
}

async fn page_route() -> Response {
    respond::html(StatusCode::OK, page::page())
}

async fn events_route(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    // The follow cursor: `Last-Event-ID` from the browser's own retries, `?cursor=` from the page's reconnects
    // (web.ts reads the header first). Subscribed and replayed under one lock, before the body starts.
    let presented = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| query.get("cursor").cloned())
        .filter(|cursor| !cursor.is_empty());
    let mut follow = state.events().subscribe_from(presented.as_deref());
    // A question answered while the client was away is not put back on its page: only waiting ones replay.
    let waiting: std::collections::HashSet<String> = state
        .harness()
        .approvals
        .as_ref()
        .map(|approvals| approvals.pending_requests())
        .unwrap_or_default()
        .iter()
        .filter_map(|request| request.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    follow.replay = follow
        .replay
        .map(|frames| stream::without_settled_approvals(frames, &waiting));
    sse_response(stream::follow_frames(
        follow,
        presented.is_some(),
        &stream::new_client_id(),
        &stream::host_home(),
        stream::heartbeat_interval().as_millis() as u64,
    ))
}

/// One session's meta as a listing entry: the store's record plus this server's run state.
fn listing_entry(meta: &SessionMeta, state: &AppState) -> Value {
    let mut value = serde_json::to_value(meta).unwrap_or_else(|_| json!({"id": meta.id}));
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    let snapshot = state.runs().snapshot(&meta.id);
    object.insert("running".into(), Value::Bool(snapshot.running));
    if let Some(since) = snapshot.running_since {
        object.insert("runningSince".into(), Value::String(iso_time(since)));
    }
    if let Some(completed) = snapshot.turn_completed_at {
        object.insert("turnCompletedAt".into(), Value::String(iso_time(completed)));
    }
    value
}

async fn list_sessions(State(state): State<AppState>) -> Response {
    let sessions: Vec<Value> = state
        .harness()
        .sessions
        .list()
        .iter()
        .map(|meta| listing_entry(meta, &state))
        .collect();
    respond::json(StatusCode::OK, &Value::Array(sessions))
}

async fn status(State(state): State<AppState>) -> Response {
    respond::json(
        StatusCode::OK,
        &json!({
            "sandbox": {"mode": state.harness().sandbox.default_mode()},
            "cwd": state.harness().sandbox.workspace_root(),
        }),
    )
}

fn service_refusal(error: ServiceError, status: StatusCode) -> Response {
    match error.code {
        Some(code) => respond::error_with_code(status, error.message, code),
        None => respond::error(status, error.message),
    }
}

async fn create_session(State(state): State<AppState>, body: JsonBody) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let branch = body
        .non_empty("branch")
        .map(canonical_path)
        .unwrap_or_else(|| canonical_path(&state.harness().cwd));
    if !workspaces.owns(&branch) {
        return respond::error(
            StatusCode::BAD_REQUEST,
            format!("{} is not under any workspace root", branch.display()),
        );
    }
    match state
        .harness()
        .sessions
        .create_at(&branch, body.non_empty("title"))
    {
        Ok(created) => respond::json(
            StatusCode::OK,
            &json!({
                "session": created.session,
                "branch": branch.display().to_string(),
                "name": created.name,
                "definition": created.definition,
                "log": created.log,
            }),
        ),
        Err(error) => service_refusal(error, StatusCode::BAD_REQUEST),
    }
}

async fn folder_session(State(state): State<AppState>, body: JsonBody) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let folder = body.non_empty("folder").map(canonical_path);
    let Some(folder) = folder.filter(|folder| workspaces.owns(folder)) else {
        return respond::error(
            StatusCode::BAD_REQUEST,
            "the folder must be under a workspace root",
        );
    };
    let options = OpenAt {
        fresh: body.bool("new") == Some(true),
        title: None,
        selection: SessionSelection::default(),
    };
    match state.harness().sessions.open_at(&folder, options) {
        Ok(id) => {
            let meta = state.harness().sessions.meta(&id);
            let mut session = Map::new();
            session.insert("id".into(), Value::String(id));
            session.insert(
                "turns".into(),
                Value::from(meta.as_ref().map(|meta| meta.turns).unwrap_or(0)),
            );
            if let Some(title) = meta.and_then(|meta| meta.title) {
                session.insert("title".into(), Value::String(title));
            }
            respond::json(
                StatusCode::OK,
                &json!({"folder": folder.display().to_string(), "session": session}),
            )
        }
        Err(error) => service_refusal(error, StatusCode::BAD_REQUEST),
    }
}

async fn session_view_route(
    State(state): State<AppState>,
    SessionPath(id): SessionPath,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let sessions = &state.harness().sessions;
    if !sessions.exists(id.as_str()) {
        return respond::no_session(id.as_str());
    }
    let Some(events) = sessions.events(id.as_str()) else {
        return respond::no_session(id.as_str());
    };
    if let Some(name) = query.get("view") {
        let Some(view) = state.session_view(name) else {
            return respond::error(StatusCode::NOT_FOUND, format!("no view {name}"));
        };
        return view.respond(&state, &id, &events);
    }
    let meta = sessions.meta(id.as_str());
    let mode = sessions.effective_mode(id.as_str(), &state.harness().sandbox.default_mode());
    let mut turns = crate::transcript::transcript_turns(&events);
    // Each card names this session: the upload route serves a file only to a session whose log references it.
    crate::transcript::scope_attachment_urls(&mut turns, id.as_str());
    if let Some(markdown) = state.harness().markdown.as_ref() {
        for turn in &mut turns {
            if turn.kind == crate::transcript::TurnKind::Assistant {
                turn.html = Some(markdown.render(&turn.text));
            }
        }
    }
    let mut body = Map::new();
    body.insert("id".into(), Value::String(id.to_string()));
    body.insert(
        "endpoint".into(),
        meta.as_ref()
            .and_then(|meta| meta.endpoint.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    body.insert(
        "model".into(),
        meta.as_ref()
            .and_then(|meta| meta.model.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    body.insert(
        "reasoningEffort".into(),
        meta.as_ref()
            .and_then(|meta| meta.reasoning_effort.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    body.insert(
        "title".into(),
        meta.as_ref()
            .and_then(|meta| meta.title.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    body.insert(
        "cwd".into(),
        meta.as_ref()
            .and_then(|meta| meta.cwd.clone())
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    body.insert("permission".into(), json!({"mode": mode}));
    body.insert(
        "turns".into(),
        serde_json::to_value(&turns).unwrap_or(Value::Array(Vec::new())),
    );
    if let Some(stats) = state.harness().stats.as_ref() {
        body.insert("stats".into(), stats.stats(id.as_str(), &events));
    }
    respond::json(StatusCode::OK, &Value::Object(body))
}

async fn fork_session(State(state): State<AppState>, SessionPath(id): SessionPath) -> Response {
    match state.harness().sessions.fork(id.as_str()) {
        ForkOutcome::NotFound => respond::no_session(id.as_str()),
        ForkOutcome::Unavailable { code } => respond::error_with_code(
            StatusCode::CONFLICT,
            format!("session {id} has no completed turn to fork from"),
            code,
        ),
        ForkOutcome::Forked(created) => respond::json(
            StatusCode::OK,
            &json!({
                "session": created.session,
                "name": created.name,
                "definition": created.definition,
                "log": created.log,
            }),
        ),
    }
}

async fn flags_session(
    State(state): State<AppState>,
    SessionPath(id): SessionPath,
    body: JsonBody,
) -> Response {
    let pinned = body.bool("pinned");
    let archived = body.bool("archived");
    if pinned.is_none() && archived.is_none() {
        return respond::error(StatusCode::BAD_REQUEST, "pinned or archived is required");
    }
    if archived == Some(true) && state.runs().is_running(id.as_str()) {
        if body.bool("stop") != Some(true) {
            return respond::json(
                StatusCode::CONFLICT,
                &json!({
                    "error": format!("session {id} is running; pass stop: true to stop it and archive"),
                    "code": "active",
                    "running": state.runs().running(id.as_str()),
                }),
            );
        }
        state.runs().abort(id.as_str());
    }
    match state
        .harness()
        .sessions
        .set_flags(id.as_str(), FlagPatch { pinned, archived })
    {
        Ok(None) => respond::no_session(id.as_str()),
        Ok(Some(meta)) => respond::json(StatusCode::OK, &meta),
        Err(error) => {
            let code = error.code.clone().unwrap_or_else(|| "archived".to_owned());
            respond::error_with_code(StatusCode::CONFLICT, error.message, code)
        }
    }
}

async fn title_session(
    State(state): State<AppState>,
    SessionPath(id): SessionPath,
    body: JsonBody,
) -> Response {
    let Some(title) = body.str("title") else {
        return respond::error(StatusCode::BAD_REQUEST, "a title is required");
    };
    let title = title.to_owned();
    let folder = body.non_empty("folder").map(canonical_path);
    if let Some(folder) = folder.as_ref()
        && state.harness().sessions.definition_id(folder).as_deref() != Some(id.as_str())
    {
        return respond::error(
            StatusCode::BAD_REQUEST,
            format!("{} does not hold {id}", folder.display()),
        );
    }
    match state.harness().sessions.rename(id.as_str(), &title) {
        None => respond::no_session(id.as_str()),
        Some(meta) => {
            if let Some(folder) = folder.as_ref()
                && let Err(error) = state
                    .harness()
                    .sessions
                    .update_definition_title(folder, &title)
            {
                return service_refusal(error, StatusCode::BAD_REQUEST);
            }
            state.events().push(
                "sessions",
                &json!({"type": "session/renamed", "session": id.as_str(), "title": title}),
            );
            respond::json(StatusCode::OK, &meta)
        }
    }
}

async fn permission_session(
    State(state): State<AppState>,
    SessionPath(id): SessionPath,
    body: JsonBody,
) -> Response {
    let sessions = &state.harness().sessions;
    if !sessions.exists(id.as_str()) {
        return respond::no_session(id.as_str());
    }
    let fallback = state.harness().sandbox.default_mode();
    let current = sessions.effective_mode(id.as_str(), &fallback);
    // Passed as they arrived, so an absent mode is refused as 'undefined', as web.ts words it.
    match state
        .harness()
        .sandbox
        .transition(&current, body.get("mode"), body.get("confirm"))
    {
        Err(reason) => respond::json(
            StatusCode::CONFLICT,
            &json!({"error": reason, "session": id.to_string(), "mode": current}),
        ),
        Ok(mode) => match sessions.set_mode(id.as_str(), &mode, &fallback) {
            Ok(written) => {
                let mut body = Map::new();
                body.insert("session".into(), Value::String(id.to_string()));
                body.insert("mode".into(), Value::String(written.mode));
                body.insert("changed".into(), Value::Bool(written.changed));
                if let Some(seq) = written.seq {
                    body.insert("seq".into(), Value::from(seq));
                }
                respond::json(StatusCode::OK, &Value::Object(body))
            }
            Err(error) => service_refusal(error, StatusCode::CONFLICT),
        },
    }
}

async fn steer_session(
    State(state): State<AppState>,
    SessionPath(id): SessionPath,
    body: JsonBody,
) -> Response {
    let Some(prompt) = body.trimmed("prompt") else {
        return respond::error(StatusCode::BAD_REQUEST, "a prompt is required");
    };
    let attachments = match state.harness().attachments.as_ref() {
        Some(reader) => match reader.read(body.get("attachments")) {
            Ok(attachments) => attachments,
            Err(message) => return respond::error(StatusCode::BAD_REQUEST, message),
        },
        None => Vec::new(),
    };
    if !state.runs().is_running(id.as_str()) {
        return respond::error_with_code(
            StatusCode::CONFLICT,
            "the current turn no longer accepts steering",
            "session/steer-unavailable",
        );
    }
    if !state.harness().sessions.exists(id.as_str()) {
        return respond::no_session(id.as_str());
    }
    let mut content = vec![json!({"type": "text", "text": prompt})];
    content.extend(attachments);
    match state.harness().sessions.user_content(id.as_str(), content) {
        Ok(()) => respond::json(
            StatusCode::OK,
            &json!({"accepted": true, "session": id.to_string()}),
        ),
        Err(error) => service_refusal(error, StatusCode::BAD_REQUEST),
    }
}

async fn stop_session(State(state): State<AppState>, SessionPath(id): SessionPath) -> Response {
    let stopped = state.runs().abort(id.as_str());
    respond::json(
        StatusCode::OK,
        &json!({"stopped": stopped, "session": id.to_string()}),
    )
}

async fn tree(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let path = query.get("path").map(canonical_path);
    let archived =
        crate::services::ArchivedFilter::from_query(query.get("archived").map(String::as_str));
    let sessions = state.harness().sessions.list();
    match workspaces.tree(path.as_deref(), archived, &sessions) {
        Ok(value) => respond::json(StatusCode::OK, &value),
        Err(error) => service_refusal(error, StatusCode::BAD_REQUEST),
    }
}

/// Every workspace with its parent and its sessions, for the page's workspace tree (web.ts's
/// `GET /api/workspaces`): `{workspaces: [{id, path, title, origin, parent, createdAt, updatedAt,
/// sessionIds}]}`, `503` when the profile loads no workspace plugin.
async fn list_workspaces(State(state): State<AppState>) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let sessions = state.harness().sessions.list();
    match workspaces.views(&sessions) {
        Ok(views) => respond::json(StatusCode::OK, &json!({"workspaces": views})),
        Err(error) => service_refusal(error, StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn add_workspace(State(state): State<AppState>, body: JsonBody) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let Some(raw) = body
        .str("path")
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return respond::error(StatusCode::BAD_REQUEST, "a path is required");
    };
    if !raw.starts_with('/') && !raw.starts_with('~') {
        return respond::error(StatusCode::BAD_REQUEST, "the path must be absolute");
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let path = canonical_path(token::expand_home(raw, &home));
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return respond::error(StatusCode::BAD_REQUEST, format!("{raw} does not exist"));
        }
    };
    if !metadata.is_dir() {
        return respond::error(StatusCode::BAD_REQUEST, format!("{raw} is not a folder"));
    }
    let name = body
        .str("name")
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if let Some(name) = name {
        let valid = name
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !valid {
            return respond::error(
                StatusCode::BAD_REQUEST,
                "a name must be lowercase letters, digits and dashes",
            );
        }
    }
    match workspaces.add(&path, name) {
        Ok((record, created)) => {
            if created {
                state
                    .events()
                    .push("workspace", &json!({"type": "workspace/added", "workspace": record}));
            }
            respond::json(
                StatusCode::OK,
                &json!({"record": record, "created": created}),
            )
        }
        Err(error) => service_refusal(error, StatusCode::BAD_REQUEST),
    }
}

async fn rename_workspace(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: JsonBody,
) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let Some(title) = body.str("title") else {
        return respond::error(StatusCode::BAD_REQUEST, "a title is required");
    };
    match workspaces.rename(&id, title) {
        Ok(Some(record)) => {
            state
                .events()
                .push("workspace", &json!({"type": "workspace/renamed", "workspace": record}));
            respond::json(StatusCode::OK, &record)
        }
        Ok(None) => respond::error(StatusCode::NOT_FOUND, format!("no workspace {id}")),
        Err(error) if error.code.as_deref() == Some("workspace/name-conflict") => {
            service_refusal(error, StatusCode::CONFLICT)
        }
        Err(error) => service_refusal(error, StatusCode::BAD_REQUEST),
    }
}

async fn remove_workspace(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    if !workspaces.find(&id) {
        return respond::error(StatusCode::NOT_FOUND, format!("no workspace {id}"));
    }
    let sessions = state.harness().sessions.list();
    match workspaces.remove(&id, &sessions) {
        Ok(outcome) => {
            state
                .events()
                .push("workspace", &json!({"type": "workspace/removed", "id": id}));
            respond::json(StatusCode::OK, &outcome)
        }
        Err(error) => service_refusal(error, StatusCode::CONFLICT),
    }
}

async fn list_approvals(State(state): State<AppState>) -> Response {
    let requests = state
        .harness()
        .approvals
        .as_ref()
        .map(|approvals| approvals.pending_requests())
        .unwrap_or_default();
    respond::json_compact(StatusCode::OK, &json!({"requests": requests}))
}

/// The 409 a question that is no longer waiting gets, in web.ts's shape (`answered: false`).
fn approval_not_waiting() -> Response {
    respond::json(
        StatusCode::CONFLICT,
        &json!({
            "answered": false,
            "error": "that question is no longer waiting; it was answered elsewhere, timed out, or this server does not hold it",
        }),
    )
}

async fn answer_approval(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: JsonBody,
) -> Response {
    // web.ts checks the id's shape, then the outcome, and only then asks the service; a malformed
    // request is a 400 whether or not an approval service is loaded.
    let looks_like_approval = id.strip_prefix("approval-").is_some_and(|rest| {
        rest.len() == 36 && rest.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    });
    if !looks_like_approval {
        return respond::error(StatusCode::BAD_REQUEST, "not an approval id");
    }
    let outcome = match body.str("outcome") {
        Some("allowed-once") => ApprovalOutcome::AllowedOnce,
        Some("rejected") => ApprovalOutcome::Rejected,
        Some("cancelled") => ApprovalOutcome::Cancelled,
        _ => {
            return respond::error(
                StatusCode::BAD_REQUEST,
                "outcome must be 'allowed-once', 'rejected' or 'cancelled'",
            );
        }
    };
    // A question nobody is holding is a conflict, not a missing plugin: a profile without the approval
    // service simply has no question to answer.
    let Some(service) = state.harness().approvals.as_ref() else {
        return approval_not_waiting();
    };
    if service.answer(&id, outcome) {
        state.events().push(
            "approval-settled",
            &json!({"type": "approval/settled", "id": id, "outcome": outcome}),
        );
        respond::json_compact(StatusCode::OK, &json!({"answered": true}))
    } else {
        approval_not_waiting()
    }
}

fn session_query(query: &HashMap<String, String>) -> Option<String> {
    query.get("session").filter(|id| !id.is_empty()).cloned()
}

async fn get_goal(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(goals) = state.harness().goals.as_ref() else {
        return respond::plugin_missing("goal");
    };
    let Some(session) = session_query(&query) else {
        return respond::error(StatusCode::BAD_REQUEST, "a session is required");
    };
    if !state.harness().sessions.exists(&session) {
        return respond::no_session(&session);
    }
    let goal = goals.get(&session);
    respond::json(StatusCode::OK, &json!({"session": session, "goal": goal}))
}

async fn get_todo(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(todos) = state.harness().todos.as_ref() else {
        return respond::plugin_missing("todo");
    };
    let Some(session) = session_query(&query) else {
        return respond::error(StatusCode::BAD_REQUEST, "a session is required");
    };
    if !state.harness().sessions.exists(&session) {
        return respond::no_session(&session);
    }
    let todo = todos.get(&session);
    respond::json(StatusCode::OK, &json!({"session": session, "todo": todo}))
}

async fn get_team(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(team) = state.harness().team.as_ref() else {
        return respond::plugin_missing("team");
    };
    let Some(session) = session_query(&query) else {
        return respond::error(StatusCode::BAD_REQUEST, "a session is required");
    };
    if !state.harness().sessions.exists(&session) {
        return respond::no_session(&session);
    }
    let view = match team.view(&session) {
        Ok(view) => view,
        Err(error) => return respond::internal_error(error.message),
    };
    respond::json(
        StatusCode::OK,
        &json!({
            "session": session,
            "lead": view.lead,
            "members": view.members,
            "tasks": view.tasks,
            "messages": view.messages,
            "delivered": view.delivered,
        }),
    )
}

async fn post_goal(State(state): State<AppState>, body: JsonBody) -> Response {
    let Some(goals) = state.harness().goals.as_ref() else {
        return respond::plugin_missing("goal");
    };
    let session = body.str("session").unwrap_or("");
    if session.is_empty() || !state.harness().sessions.exists(session) {
        return respond::no_session(session);
    }
    let reference = GoalRef {
        id: body.str("goal_id").unwrap_or("").to_owned(),
        revision: body.number("revision").unwrap_or(0.0) as u64,
    };
    let action = match body.str("action").unwrap_or("") {
        "create" => GoalAction::Create {
            objective: body.str("objective").unwrap_or("").to_owned(),
            max_goal_rounds: body.number("max_goal_rounds").map(|value| value as u64),
        },
        "edit" => GoalAction::Edit {
            goal: reference,
            objective: body.str("objective").map(str::to_owned),
            max_goal_rounds: body.number("max_goal_rounds").map(|value| value as u64),
        },
        "pause" => GoalAction::Pause(reference),
        "resume" => GoalAction::Resume(reference),
        "complete" => GoalAction::Complete(reference),
        "blocked" => GoalAction::Blocked {
            goal: reference,
            reason: body.get("blocked_reason").cloned().unwrap_or(Value::Null),
        },
        "clear" => GoalAction::Clear(reference),
        other => {
            return respond::error(
                StatusCode::BAD_REQUEST,
                format!(
                    "unknown goal action {}",
                    serde_json::to_string(other).unwrap_or_default()
                ),
            );
        }
    };
    match goals.act(session, action) {
        Ok(GoalAnswer::Goal(view)) => respond::json(StatusCode::OK, &json!({"goal": view})),
        Ok(GoalAnswer::Cleared(cleared)) => {
            respond::json(StatusCode::OK, &json!({"cleared": cleared}))
        }
        Err(error) => {
            let status = match error.code.as_deref() {
                Some("GOAL_NOT_FOUND") => StatusCode::NOT_FOUND,
                Some("GOAL_STALE_REVISION") => StatusCode::CONFLICT,
                _ => StatusCode::BAD_REQUEST,
            };
            respond::error_with_code(status, error.message, error.code.unwrap_or_default())
        }
    }
}

async fn html_preview(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(wanted) = query.get("path").filter(|path| !path.is_empty()) else {
        return respond::error(StatusCode::BAD_REQUEST, "a path is required");
    };
    // A profile without the workspace plugin has no roots, so every path is outside them: the
    // TypeScript route answers that, not a plugin-missing error.
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::error(
            StatusCode::NOT_FOUND,
            "that path is not under any workspace root",
        );
    };
    let path = canonical_path(wanted);
    if !workspaces.owns(&path) {
        return respond::error(
            StatusCode::NOT_FOUND,
            "that path is not under any workspace root",
        );
    }
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return respond::error(StatusCode::NOT_FOUND, "not a file"),
    };
    if metadata.len() > preview::MAX_PREVIEW_BYTES {
        return respond::error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "the document is larger than 4MB",
        );
    }
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(_) => return respond::error(StatusCode::NOT_FOUND, "no such document"),
    };
    let document = preview::prepare_document(&path, &source, metadata.len());
    respond::json(StatusCode::OK, &document)
}

async fn purify(State(state): State<AppState>) -> Response {
    // The browser loads this as a script, so it is served as JavaScript rather than through the
    // inline/download file answer: an `attachment` content-disposition here would leave the preview
    // page without a sanitiser.
    let Some(path) = preview::purify_path(&state.options().asset_roots) else {
        return respond::text(StatusCode::NOT_FOUND, "the sanitiser is not installed\n");
    };
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/javascript; charset=utf-8")
            .header("cache-control", "no-store")
            .body(Body::from(bytes))
            .expect("a response builder with static headers"),
        Err(_) => respond::text(StatusCode::NOT_FOUND, "the sanitiser is not installed\n"),
    }
}

// ---------------------------------------------------------------------------------------------------------
// The turn

/// web.ts serves through Node's http server, which turns Nagle's algorithm off on every connection it
/// accepts (`noDelay` defaults to true), so a small frame leaves when it is written. With Nagle on, a live
/// `/api/events` frame could sit in the kernel waiting for an acknowledgement while another connection's
/// `done` went out first — the page then finishes a turn whose last text has not arrived (80
/// check-chat-view #16).
fn without_nagle(
    listener: tokio::net::TcpListener,
) -> impl axum::serve::Listener<Io = tokio::net::TcpStream, Addr = std::net::SocketAddr> {
    use axum::serve::ListenerExt;
    listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    })
}

async fn turn(State(state): State<AppState>, body: JsonBody) -> Response {
    let Some(prompt) = body.str("prompt").filter(|prompt| !prompt.is_empty()) else {
        return respond::text(StatusCode::BAD_REQUEST, "a prompt is required\n");
    };
    let attachments = match state.harness().attachments.as_ref() {
        Some(reader) => match reader.read(body.get("attachments")) {
            Ok(attachments) => attachments,
            Err(message) => return respond::error(StatusCode::BAD_REQUEST, message),
        },
        None => Vec::new(),
    };

    let requested_endpoint = body.non_empty("endpoint");
    let requested_model = body.non_empty("model");
    let requested_effort = body.non_empty("reasoningEffort");
    let models = state.harness().models.as_ref();
    if let Some(endpoint) = requested_endpoint
        && !models.has(endpoint)
    {
        return respond::text(
            StatusCode::BAD_REQUEST,
            format!(
                "no endpoint named '{endpoint}'; configured: {}\n",
                models.names().join(", ")
            ),
        );
    }

    let born = SessionSelection {
        endpoint: requested_endpoint.map(str::to_owned),
        model: requested_model.map(str::to_owned),
        reasoning_effort: requested_effort.map(str::to_owned),
    };
    let sessions = &state.harness().sessions;
    let resume = body.str("session").filter(|id| !id.is_empty());
    let folder = body.non_empty("folder").map(canonical_path);
    let title: String = prompt.chars().take(60).collect();
    let session = if let Some(resume) = resume {
        // A resumed session keeps the selection it recorded; only a session this request creates is
        // born with the request's choice (web.ts passes `{ resume }` alone).
        sessions.start(StartSession {
            resume: Some(resume.to_owned()),
            cwd: None,
            title: None,
            selection: SessionSelection::default(),
        })
    } else if let Some(folder) = folder.as_ref() {
        // web.ts opens the folder's session whether or not a workspace owns the folder, then adopts it
        // (`ctx.workspace?.ensureOwner(folder)`, below); the ownership refusal belongs to the new-session
        // route, not to a turn.
        sessions.open_at(
            folder,
            OpenAt {
                fresh: body.bool("new") == Some(true),
                title: Some(title),
                selection: born.clone(),
            },
        )
    } else {
        sessions.start(StartSession {
            resume: None,
            cwd: Some(state.harness().cwd.clone()),
            title: Some(title),
            selection: born.clone(),
        })
    };
    let session = match session {
        Ok(session) => session,
        Err(error) => return service_refusal(error, StatusCode::BAD_REQUEST),
    };
    if let Some(folder) = folder.as_ref()
        && let Some(workspaces) = state.harness().workspaces.as_ref()
    {
        workspaces.ensure_owner(folder);
    }

    let meta = sessions.meta(&session);
    let recorded = session_request_selection(meta.as_ref());
    let Some(selection) = turn_selection(
        requested_endpoint,
        requested_model,
        requested_effort,
        &recorded,
        state.options().default_endpoint.as_deref(),
        models,
    ) else {
        return respond::text(StatusCode::BAD_REQUEST, "no endpoint is configured\n");
    };
    if !models.has(&selection.endpoint) {
        return respond::text(
            StatusCode::BAD_REQUEST,
            format!(
                "no endpoint named '{}'; configured: {}\n",
                selection.endpoint,
                models.names().join(", ")
            ),
        );
    }
    let unchanged = meta.as_ref().is_some_and(|meta| {
        meta.endpoint.as_deref() == Some(selection.endpoint.as_str())
            && meta.model == selection.model
            && meta.reasoning_effort == selection.reasoning_effort
    });
    if !unchanged {
        let recorded_selection = SessionSelection {
            endpoint: Some(selection.endpoint.clone()),
            model: selection.model.clone(),
            reasoning_effort: selection.reasoning_effort.clone(),
        };
        sessions.set_model(&session, &recorded_selection);
    }

    let guard = state.runs().begin(&session);
    let cancel = guard.cancellation();
    let request = crate::services::TurnRequest {
        session: session.clone(),
        endpoint: selection.endpoint.clone(),
        prompt: prompt.to_owned(),
        attachments,
        cancel: cancel.clone(),
        max_rounds: state.options().max_rounds,
        model: selection.model.clone(),
        reasoning_effort: selection.reasoning_effort.clone(),
    };
    let runner = state.harness().turns.clone();
    let sessions = state.harness().sessions.clone();
    let mut frames = Box::pin(state.events().subscribe().for_session(session.clone()));
    let (sender, receiver) = mpsc::unbounded_channel::<SseFrame>();
    let stream_session = session.clone();
    tokio::spawn(async move {
        use futures::{Stream, StreamExt};
        let mut running = Box::pin(runner.run_turn(request));
        let outcome = loop {
            tokio::select! {
                frame = frames.next() => {
                    match frame {
                        Some(frame) => {
                            if sender.send(frame).is_err() {
                                // The reader is gone (the page reloaded or navigated away); the turn is the
                                // server's, not the request's, so it runs to its end and records its
                                // completion. Only the forwarding stops.
                                break Some(running.as_mut().await);
                            }
                        }
                        None => break Some(running.as_mut().await),
                    }
                }
                result = &mut running => break Some(result),
            }
        };
        // The turn is over, so it stops running now: web.ts clears it in the tick the turn ends, and a page
        // that saw `turn/completed` reads the list as not running.
        drop(guard);
        // A fast turn can publish its last events and return in the same poll. Drain what is already
        // queued before the terminal frame, so a client never sees `done` before the answer it closes.
        {
            let waker = futures::task::noop_waker();
            let mut context = std::task::Context::from_waker(&waker);
            while let std::task::Poll::Ready(Some(frame)) = frames.as_mut().poll_next(&mut context)
            {
                if sender.send(frame).is_err() {
                    break;
                }
            }
        }
        // The terminal frame does not wait for the `/api/events` readers, as web.ts's does not: it writes
        // `done` when the turn ends, whatever those responses have taken. Holding `done` until the live
        // stream had taken the text (16db838) made a page more likely to handle `done` mid-answer, which is
        // the window in which page.html's renderSettledAnswers overwrites a growing row (80 check-chat-view
        // #16): measured on a cold-browser harness, 5 failures in 200 with the wait and 1 in 200 without.
        let stopped = || {
            SseFrame::new(
                names::CANCELLED,
                &json!({"session": stream_session, "message": "stopped"}),
            )
        };
        match outcome {
            None => {}
            Some(Ok(outcome)) => {
                if cancel.is_cancelled() {
                    let _ = sender.send(stopped());
                } else {
                    let mut done = Map::new();
                    done.insert("session".into(), Value::String(stream_session));
                    done.insert("text".into(), Value::String(outcome.text));
                    done.insert("finishReason".into(), Value::String(outcome.finish_reason));
                    done.insert("rounds".into(), Value::from(outcome.rounds));
                    done.insert("denials".into(), Value::Array(outcome.denials));
                    if let Some(ended) = outcome.ended {
                        done.insert(
                            "ended".into(),
                            Value::Array(ended.into_iter().map(Value::String).collect()),
                        );
                    }
                    if let Some(usage) = outcome.usage {
                        done.insert("usage".into(), usage);
                    }
                    let _ = sender.send(SseFrame::new(names::DONE, &Value::Object(done)));
                }
            }
            Some(Err(error)) => {
                if cancel.is_cancelled() {
                    let _ = sender.send(stopped());
                } else {
                    let _ = sender.send(SseFrame::new(
                        names::ERROR,
                        &json!({"session": stream_session, "message": error.message.clone()}),
                    ));
                    // Recorded as well, so the failure reaches every client and every later read
                    // (R-developer-six-2, DSH's api-session/error); web.ts appends the same `turn/failed`.
                    if let Err(failure) = sessions.record(
                        &stream_session,
                        "turn/failed",
                        json!({"message": error.message}),
                    ) {
                        eprintln!(
                            "heddle web: the failed turn could not be recorded: {}",
                            failure.message
                        );
                    }
                }
            }
        }
    });
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|frame| (frame, receiver))
    });
    sse_response(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::selection::SessionSelection;
    use crate::services::{
        ApprovalService, CreatedSession, ForkOutcome, ModeWrite, ModelService, SandboxService,
        SessionMeta, SessionService, TurnOutcome, TurnRequest, TurnRunner,
    };
    use axum::body::to_bytes;
    use futures::future::BoxFuture;
    use http_body_util::BodyExt;
    use std::path::Path;
    use tower::ServiceExt;

    struct Sessions {
        metas: Vec<SessionMeta>,
        events: HashMap<String, Vec<Value>>,
        /// Every `record` call, as `(session, type, fields)`.
        recorded: std::sync::Mutex<Vec<(String, String, Value)>>,
    }

    impl Sessions {
        fn with_one() -> Self {
            Sessions {
                metas: vec![SessionMeta {
                    id: "session-00000000-0000-0000-0000-000000000001".into(),
                    cwd: Some("/work".into()),
                    endpoint: Some("double".into()),
                    title: Some("first".into()),
                    turns: 1,
                    ..SessionMeta::default()
                }],
                events: HashMap::new(),
                recorded: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl SessionService for Sessions {
        fn record(&self, id: &str, kind: &str, fields: Value) -> Result<(), ServiceError> {
            self.recorded
                .lock()
                .unwrap()
                .push((id.to_owned(), kind.to_owned(), fields));
            Ok(())
        }
        fn list(&self) -> Vec<SessionMeta> {
            self.metas.clone()
        }
        fn exists(&self, id: &str) -> bool {
            self.metas.iter().any(|meta| meta.id == id)
        }
        fn events(&self, id: &str) -> Option<Vec<Value>> {
            self.events.get(id).cloned().or(Some(Vec::new()))
        }
        fn start(&self, _options: StartSession) -> Result<String, ServiceError> {
            Ok(self.metas[0].id.clone())
        }
        fn open_at(&self, _folder: &Path, _options: OpenAt) -> Result<String, ServiceError> {
            Ok(self.metas[0].id.clone())
        }
        fn create_at(
            &self,
            _branch: &Path,
            _title: Option<&str>,
        ) -> Result<CreatedSession, ServiceError> {
            Ok(CreatedSession {
                session: self.metas[0].id.clone(),
                name: "test".into(),
                definition: "def.yaml".into(),
                log: "log.zst".into(),
            })
        }
        fn fork(&self, _id: &str) -> ForkOutcome {
            ForkOutcome::NotFound
        }
        fn set_flags(
            &self,
            _id: &str,
            _patch: FlagPatch,
        ) -> Result<Option<SessionMeta>, ServiceError> {
            Ok(self.metas.first().cloned())
        }
        fn rename(&self, _id: &str, _title: &str) -> Option<SessionMeta> {
            self.metas.first().cloned()
        }
        fn definition_id(&self, _folder: &Path) -> Option<String> {
            None
        }
        fn update_definition_title(
            &self,
            _folder: &Path,
            _title: &str,
        ) -> Result<(), ServiceError> {
            Ok(())
        }
        fn set_model(&self, _id: &str, _selection: &SessionSelection) -> Option<SessionMeta> {
            self.metas.first().cloned()
        }
        fn effective_mode(&self, _id: &str, fallback: &str) -> String {
            fallback.to_owned()
        }
        fn set_mode(
            &self,
            _id: &str,
            mode: &str,
            _fallback: &str,
        ) -> Result<ModeWrite, ServiceError> {
            Ok(ModeWrite {
                mode: mode.to_owned(),
                changed: true,
                seq: Some(1),
            })
        }
        fn user_content(&self, _id: &str, _content: Vec<Value>) -> Result<(), ServiceError> {
            Ok(())
        }
        fn folder(&self, _id: &str) -> Option<PathBuf> {
            None
        }
    }

    struct Models;

    impl ModelService for Models {
        fn names(&self) -> Vec<String> {
            vec!["double".into()]
        }
        fn default_endpoint(&self) -> Option<String> {
            Some("double".into())
        }
        fn declares_level(&self, _endpoint: &str, _model: Option<&str>, _effort: &str) -> bool {
            true
        }
    }

    struct Turns;

    impl TurnRunner for Turns {
        fn run_turn(
            &self,
            _request: TurnRequest,
        ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
            Box::pin(async { Ok(TurnOutcome::default()) })
        }
    }

    struct Sandbox;

    impl SandboxService for Sandbox {
        fn default_mode(&self) -> String {
            "workspace-write".into()
        }
        fn workspace_root(&self) -> String {
            "/work".into()
        }
        fn transition(
            &self,
            _current: &str,
            _requested: Option<&Value>,
            _confirm: Option<&Value>,
        ) -> Result<String, String> {
            Ok("read-only".into())
        }
    }

    struct ApprovalTracker {
        attached: Arc<std::sync::atomic::AtomicBool>,
    }

    impl ApprovalService for ApprovalTracker {
        fn attach_answerer(&self) -> Box<dyn FnOnce() + Send> {
            self.attached
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let attached = Arc::clone(&self.attached);
            Box::new(move || attached.store(false, std::sync::atomic::Ordering::SeqCst))
        }
        fn pending_requests(&self) -> Vec<Value> {
            Vec::new()
        }
        fn answer(&self, _id: &str, _outcome: ApprovalOutcome) -> bool {
            false
        }
    }

    /// An approval service that publishes questions on a channel, the way heddle-sandbox's broadcast does.
    struct PublishingApprovals {
        questions: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Value>>>,
    }

    impl ApprovalService for PublishingApprovals {
        fn attach_answerer(&self) -> Box<dyn FnOnce() + Send> {
            Box::new(|| {})
        }
        fn pending_requests(&self) -> Vec<Value> {
            Vec::new()
        }
        fn answer(&self, _id: &str, _outcome: ApprovalOutcome) -> bool {
            false
        }
        fn subscribe(&self) -> Option<futures::stream::BoxStream<'static, Value>> {
            let receiver = self.questions.lock().unwrap().take()?;
            Some(Box::pin(futures::stream::unfold(
                receiver,
                |mut receiver| async move { receiver.recv().await.map(|value| (value, receiver)) },
            )))
        }
    }

    struct Approvals;

    impl ApprovalService for Approvals {
        fn attach_answerer(&self) -> Box<dyn FnOnce() + Send> {
            Box::new(|| {})
        }
        fn pending_requests(&self) -> Vec<Value> {
            Vec::new()
        }
        fn answer(&self, _id: &str, _outcome: ApprovalOutcome) -> bool {
            false
        }
    }

    #[test]
    fn the_harness_builder_attaches_only_the_services_it_is_given() {
        let harness = Harness::builder(
            Arc::new(Sessions::with_one()),
            Arc::new(Models),
            Arc::new(Turns),
            Arc::new(Sandbox),
            PathBuf::from("/work"),
        )
        .approvals(Arc::new(Approvals))
        .markdown(crate::services::markdown_renderer(|text| {
            format!("<p>{text}</p>")
        }))
        .build();
        assert!(harness.approvals.is_some());
        assert!(harness.markdown.is_some());
        assert!(harness.workspaces.is_none());
        assert!(harness.goals.is_none());
        assert_eq!(harness.cwd, PathBuf::from("/work"));
    }

    fn harness() -> Harness {
        let mut harness = Harness::new(
            Arc::new(Sessions::with_one()),
            Arc::new(Models),
            Arc::new(Turns),
            Arc::new(Sandbox),
            PathBuf::from("/work"),
        );
        harness.approvals = Some(Arc::new(Approvals));
        harness
    }

    /// A folder a test made under the system temp dir, removed when it is dropped.
    struct TempFolder(PathBuf);

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    thread_local! {
        /// The temp folders of the test running on this thread. The harness runs each test on its own thread, and a
        /// thread's locals are dropped when it ends, after a panic's unwinding too, so a failing test cleans up as a
        /// passing one does. Before, every run left its `heddle-server-test-*` folders in TMPDIR (1,218 counted).
        static TEMP_FOLDERS: std::cell::RefCell<Vec<TempFolder>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// A secret path in a folder of its own, owned by the calling test: labels are unique per test, so no two
    /// running tests share a folder, and the folder goes when the test's thread ends.
    fn temp_secret(label: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("heddle-server-test-{label}-{}", std::process::id()));
        TEMP_FOLDERS.with(|folders| folders.borrow_mut().push(TempFolder(folder.clone())));
        folder.join("web-secret")
    }

    #[test]
    fn a_tests_temp_folder_is_removed_when_its_thread_ends() {
        let folder = std::thread::spawn(|| {
            let secret = temp_secret("cleanup-probe");
            let folder = secret.parent().unwrap().to_path_buf();
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(&secret, "s").unwrap();
            assert!(folder.exists());
            folder
        })
        .join()
        .unwrap();
        assert!(!folder.exists(), "the folder went with the thread that made it");
        let panicked = std::thread::spawn(|| {
            let secret = temp_secret("cleanup-probe-panic");
            std::fs::create_dir_all(secret.parent().unwrap()).unwrap();
            panic!("a failing test");
        })
        .join();
        assert!(panicked.is_err());
        let folder = std::env::temp_dir().join(format!("heddle-server-test-cleanup-probe-panic-{}", std::process::id()));
        assert!(!folder.exists(), "and a panicking test cleans up too");
    }

    fn app(label: &str) -> (Router, AppState) {
        ServerBuilder::new(
            harness(),
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret(label)),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router")
    }

    async fn call(
        router: &Router,
        method: Method,
        uri: &str,
        cookie: Option<&str>,
    ) -> (StatusCode, HashMap<String, String>, Vec<u8>) {
        let mut request = axum::http::Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, headers, bytes)
    }

    fn body_text(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn healthz_and_the_favicon_need_no_token() {
        let (router, _) = app("health");
        let (status, headers, bytes) = call(&router, Method::GET, "/healthz", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "application/json");
        assert_eq!(
            body_text(&bytes),
            format!("{{\"ok\":true,\"service\":\"{SERVICE_NAME}\",\"port\":3082}}\n")
        );

        let (status, headers, bytes) = call(&router, Method::GET, "/favicon.svg", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "image/svg+xml");
        assert!(!bytes.is_empty());
    }

    #[tokio::test]
    async fn the_api_refuses_without_a_credential_and_says_so() {
        let (router, _) = app("unauthorized");
        let (status, _, bytes) = call(&router, Method::GET, "/api/sessions", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body_text(&bytes), "unauthorized\n");
    }

    #[tokio::test]
    async fn the_bare_page_is_the_token_form_not_the_app() {
        let (router, _) = app("bare");
        let (status, headers, bytes) = call(&router, Method::GET, "/", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers["content-type"], "text/html; charset=utf-8");
        let html = body_text(&bytes);
        assert!(html.contains("A launch token is required for this page."));
        assert!(html.contains("<form method=\"get\" action=\"/\">"));
        assert!(!html.contains("id=\"log\""));
    }

    #[tokio::test]
    async fn a_wrong_token_is_the_stale_form_and_the_right_one_mints_a_cookie() {
        let (router, _) = app("handshake");
        let (status, _, bytes) = call(&router, Method::GET, "/?token=wrong", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body_text(&bytes).contains("That token is not the current one."));

        let (status, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(headers["location"], "/");
        assert_eq!(headers["cache-control"], "no-store");
        assert_eq!(headers["referrer-policy"], "no-referrer");
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        assert!(cookie.starts_with("heddle-auth-"));
        assert!(headers["set-cookie"].contains("HttpOnly"));
        assert!(headers["set-cookie"].contains("SameSite=Strict"));

        // The bare URL with that cookie is the app, and the API is served.
        let (status, _, bytes) = call(&router, Method::GET, "/", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body_text(&bytes).contains("id=\"log\""));

        let (status, _, bytes) = call(&router, Method::GET, "/api/sessions", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body[0]["id"],
            "session-00000000-0000-0000-0000-000000000001"
        );
        assert_eq!(body[0]["running"], false);
    }

    #[tokio::test]
    async fn a_forged_cookie_is_refused_and_a_wrong_authority_does_not_authenticate() {
        let (router, _) = app("forged");
        let (status, _, _) = call(
            &router,
            Method::GET,
            "/api/sessions",
            Some("heddle-auth-x=v1.1.forged"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_fence_refuses_a_foreign_host_and_origin_before_the_token() {
        let (router, _) = app("fence");
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/sessions")
                    .header("host", "evil.example:3082")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(body_text(&bytes).contains("is not loopback"));

        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/sessions")
                    .header("origin", "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_same_machine_gate_origin_is_served_and_an_opaque_one_is_refused() {
        let (router, _) = app("origin");
        // A handshake first, because the gate carries the cookie.
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/sessions")
                    .header("cookie", &cookie)
                    .header("origin", "http://127.0.0.1:8082")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/turn")
                    .header("cookie", &cookie)
                    .header("origin", "null")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_cross_site_write_without_a_valid_cookie_is_403() {
        let (router, _) = app("cross-site");
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/turn")
                    .header(
                        "cookie",
                        format!("{}=v1.1.forged", cookie_name("127.0.0.1:3082")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(body_text(&bytes).contains("a cross-site request that changes state"));
    }

    #[tokio::test]
    async fn approvals_are_listed_and_an_unknown_question_is_a_conflict() {
        let (router, _) = app("approvals");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(&router, Method::GET, "/api/approvals", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body_text(&bytes), "{\"requests\":[]}\n");

        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/approvals/approval-00000000-0000-0000-0000-000000000000")
                    .header("cookie", &cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"outcome":"allowed-once"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    /// A registry double for the workspace-tree route: it answers what it was given, and records that
    /// the route handed it the store's sessions.
    struct ViewWorkspaces;

    impl crate::services::WorkspaceService for ViewWorkspaces {
        fn owns(&self, _path: &std::path::Path) -> bool {
            true
        }
        fn tree(
            &self,
            _path: Option<&std::path::Path>,
            _archived: crate::services::ArchivedFilter,
            _sessions: &[SessionMeta],
        ) -> Result<Value, ServiceError> {
            Ok(json!({}))
        }
        fn add(
            &self,
            _path: &std::path::Path,
            _name: Option<&str>,
        ) -> Result<(Value, bool), ServiceError> {
            Ok((json!({}), false))
        }
        fn find(&self, _id: &str) -> bool {
            false
        }
        fn remove(&self, _id: &str, _sessions: &[SessionMeta]) -> Result<Value, ServiceError> {
            Ok(json!({}))
        }
        fn rename(&self, _id: &str, _title: &str) -> Result<Option<Value>, ServiceError> {
            Ok(None)
        }
        fn ensure_owner(&self, _folder: &std::path::Path) {}
        fn views(&self, sessions: &[SessionMeta]) -> Result<Value, ServiceError> {
            let ids: Vec<Value> = sessions
                .iter()
                .map(|meta| Value::String(meta.id.clone()))
                .collect();
            Ok(
                json!([{"id": "w-1", "path": "/work", "title": "work", "origin": "added",
                "parent": null, "createdAt": "a", "updatedAt": "a", "sessionIds": ids}]),
            )
        }
    }

    #[tokio::test]
    async fn the_workspace_tree_route_answers_the_registry_views_and_503_without_the_plugin() {
        // Without the plugin: the same refusal every workspace route gives.
        let (router, _) = app("workspaces-missing");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, _) = call(&router, Method::GET, "/api/workspaces", Some(&cookie)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

        // With it: `{workspaces: [...]}`, fed the store's sessions.
        let mut with_registry = harness();
        with_registry.workspaces = Some(Arc::new(ViewWorkspaces));
        let (router, _) = ServerBuilder::new(
            with_registry,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("workspaces-views")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, headers, bytes) =
            call(&router, Method::GET, "/api/workspaces", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "application/json");
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let first = &body["workspaces"][0];
        assert_eq!(first["id"], "w-1");
        assert_eq!(first["parent"], Value::Null);
        assert_eq!(
            first["sessionIds"].as_array().map(Vec::len),
            Some(1),
            "the route hands the registry the store's sessions: {body}"
        );
    }

    #[tokio::test]
    async fn status_names_the_deployment_mode_and_root() {
        let (router, _) = app("status");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(&router, Method::GET, "/api/status", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        // web.ts writes `{ sandbox, cwd }`; with serde_json's preserve_order (enabled by
        // heddle-llm in the lane) the insertion order is the emitted order, so the bytes match.
        assert_eq!(
            body_text(&bytes),
            "{\n  \"sandbox\": {\n    \"mode\": \"workspace-write\"\n  },\n  \"cwd\": \"/work\"\n}\n"
        );
    }

    #[tokio::test]
    async fn a_session_view_is_refused_when_it_does_not_exist_and_the_chat_view_has_its_record() {
        let (router, _) = app("chat");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(
            &router,
            Method::GET,
            "/api/sessions/session-00000000-0000-0000-0000-000000000001",
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["id"], "session-00000000-0000-0000-0000-000000000001");
        assert_eq!(body["endpoint"], "double");
        assert_eq!(body["permission"]["mode"], "workspace-write");
        assert!(body["turns"].is_array());
    }

    #[tokio::test]
    async fn an_unknown_session_is_404_and_a_non_id_is_400() {
        let (router, _) = app("missing");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(
            &router,
            Method::GET,
            "/api/sessions/session-11111111-1111-1111-1111-111111111111",
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            body_text(&bytes),
            "{\"error\":\"no session session-11111111-1111-1111-1111-111111111111\"}\n"
        );

        let (status, _, bytes) = call(
            &router,
            Method::GET,
            "/api/sessions/..%2F..%2Fetc%2Fpasswd",
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body_text(&bytes), "{\"error\":\"not a session id\"}\n");
    }

    #[tokio::test]
    async fn the_dry_run_plan_does_not_bind_and_names_the_default() {
        let plan = DryRunPlan::for_options(&ServerOptions::default());
        assert_eq!(plan.port, DEFAULT_PORT);
        assert_eq!(plan.host, DEFAULT_HOST);
        assert_eq!(plan.url, "http://127.0.0.1:3082/?token=generated-at-start");
        assert_eq!(
            plan.announce(),
            "heddle web: would serve http://127.0.0.1:3082/?token=generated-at-start"
        );
        let json = serde_json::to_value(&plan).unwrap();
        assert_eq!(json["dryRun"], true);
    }

    #[test]
    fn a_non_loopback_bind_is_refused() {
        let builder = ServerBuilder::new(
            harness(),
            ServerOptions {
                host: Some("0.0.0.0".into()),
                token: Some("x".into()),
                secret_path: Some(temp_secret("bind")),
                ..ServerOptions::default()
            },
        );
        let error = builder.into_router(3082).err().expect("a refusal");
        assert!(
            matches!(error, ServerError::NotLoopback(sentence) if sentence.contains("refusing to bind 0.0.0.0"))
        );
    }

    #[tokio::test]
    async fn an_unavailable_harness_serves_the_door_and_refuses_a_turn() {
        let builder = ServerBuilder::new(
            Harness::unavailable(PathBuf::from("/work")),
            ServerOptions {
                port: Some(0),
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("unavailable")),
                default_endpoint: Some("double".into()),
                ..ServerOptions::default()
            },
        );
        let (router, _) = builder.into_router(3082).expect("the test router");
        let (status, _, _) = call(&router, Method::GET, "/healthz", None).await;
        assert_eq!(status, StatusCode::OK);

        let (status, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let (status, _, bytes) = call(&router, Method::GET, "/api/sessions", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body_text(&bytes), "[]\n");

        let (status, bytes) = post_json(&router, "/api/turn", &cookie, r#"{"prompt":"hi"}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(&bytes),
            "{\"error\":\"this service is not loaded yet\"}\n"
        );
    }

    #[tokio::test]
    async fn a_published_approval_question_reaches_the_event_stream() {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut harness = harness();
        harness.approvals = Some(Arc::new(PublishingApprovals {
            questions: std::sync::Mutex::new(Some(receiver)),
        }));
        let server = ServerBuilder::new(
            harness,
            ServerOptions {
                port: Some(0),
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("approval-relay")),
                ..ServerOptions::default()
            },
        )
        .start()
        .await
        .expect("the server starts");
        let mut frames = server.state().events().subscribe();

        let question = serde_json::json!({
            "id": "approval-00000000-0000-0000-0000-000000000000",
            "tool": "write_file",
            "reason": "write outside the workspace",
            "displayReason": "write outside the workspace",
            "at": "2026-10-23T01:16:42.123Z"
        });
        sender.send(question.clone()).unwrap();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), frames.next_frame())
            .await
            .expect("the question is relayed")
            .expect("the hub is open");
        assert_eq!(frame.event, "approval");
        assert_eq!(
            serde_json::from_str::<Value>(&frame.data).unwrap(),
            question
        );

        server.close().await;
        // After close the relay is gone: nothing is delivered to a closed hub.
        let _ = sender.send(serde_json::json!({"id": "late"}));
    }

    #[tokio::test]
    async fn the_running_server_answers_approvals_and_detaches_on_close() {
        use std::sync::atomic::Ordering;
        let attached = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut harness = harness();
        harness.approvals = Some(Arc::new(ApprovalTracker {
            attached: Arc::clone(&attached),
        }));
        let server = ServerBuilder::new(
            harness,
            ServerOptions {
                port: Some(0),
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("approval-attach")),
                ..ServerOptions::default()
            },
        )
        .start()
        .await
        .expect("the server starts");
        assert!(
            attached.load(Ordering::SeqCst),
            "a running server is the approval answerer"
        );
        server.close().await;
        assert!(
            !attached.load(Ordering::SeqCst),
            "closing detaches the answerer"
        );
    }

    #[tokio::test]
    async fn the_server_starts_on_an_ephemeral_port_and_announces_its_url() {
        let server = ServerBuilder::new(
            harness(),
            ServerOptions {
                port: Some(0),
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("start")),
                ..ServerOptions::default()
            },
        )
        .start()
        .await
        .expect("the server starts");
        assert!(server.port() > 0);
        assert_eq!(
            server.url(),
            format!("http://127.0.0.1:{}/?token=test-token", server.port())
        );
        assert_eq!(
            server.announce()[0],
            format!(
                "heddle web: http://127.0.0.1:{}/?token=test-token",
                server.port()
            )
        );
        assert!(server.announce_json().contains("\"port\":"));
        server.close().await;
    }

    /// A turn runner that publishes into the server's hub before it returns, so the streaming path is
    /// judged end to end: the events and the terminal frame in one response.
    struct StreamingTurns {
        hub: Arc<std::sync::OnceLock<EventHub>>,
        text: String,
    }

    impl TurnRunner for StreamingTurns {
        fn run_turn(
            &self,
            request: TurnRequest,
        ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
            let hub = Arc::clone(&self.hub);
            let text = self.text.clone();
            Box::pin(async move {
                if let Some(hub) = hub.get() {
                    hub.publish_session_event(
                        &request.session,
                        &serde_json::json!({
                            "type": "assistant/chunk",
                            "chunk": {"type": "text-delta", "text": text}
                        }),
                    );
                    hub.publish_session_event(
                        &request.session,
                        &serde_json::json!({"type": "assistant/completed", "text": text}),
                    );
                }
                Ok(TurnOutcome {
                    text,
                    finish_reason: "stop".into(),
                    rounds: 1,
                    denials: Vec::new(),
                    ended: None,
                    usage: None,
                })
            })
        }
    }

    fn app_with_runner(label: &str, runner: Arc<StreamingTurns>) -> (Router, AppState) {
        let mut harness = harness();
        harness.turns = Arc::clone(&runner) as Arc<dyn TurnRunner>;
        let builder = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret(label)),
                ..ServerOptions::default()
            },
        );
        let _ = runner.hub.set(builder.events());
        builder.into_router(3082).expect("the test router")
    }

    async fn post_json(
        router: &Router,
        uri: &str,
        cookie: &str,
        body: &str,
    ) -> (StatusCode, Vec<u8>) {
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri(uri)
                    .header("cookie", cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, bytes)
    }

    /// A runner that waits for a signal, publishes one event, then finishes a moment later.
    struct DetachedTurns {
        hub: Arc<std::sync::OnceLock<EventHub>>,
        release: Arc<tokio::sync::Notify>,
        finished: Arc<std::sync::atomic::AtomicBool>,
    }

    impl TurnRunner for DetachedTurns {
        fn run_turn(
            &self,
            request: TurnRequest,
        ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
            let hub = Arc::clone(&self.hub);
            let release = Arc::clone(&self.release);
            let finished = Arc::clone(&self.finished);
            Box::pin(async move {
                release.notified().await;
                if let Some(hub) = hub.get() {
                    hub.publish_session_event(
                        &request.session,
                        &serde_json::json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "x"}}),
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                finished.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(TurnOutcome {
                    text: "x".into(),
                    finish_reason: "stop".into(),
                    rounds: 1,
                    denials: Vec::new(),
                    ended: None,
                    usage: None,
                })
            })
        }
    }

    #[tokio::test]
    async fn a_turn_runs_to_its_end_after_its_reader_goes_away() {
        // web.ts: a page that reloads mid-turn drops the request, not the turn; the turn completes and the
        // list reports it finished (80 check-chat-view, the weaving clock).
        let runner = Arc::new(DetachedTurns {
            hub: Arc::new(std::sync::OnceLock::new()),
            release: Arc::new(tokio::sync::Notify::new()),
            finished: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        let mut harness = harness();
        harness.turns = Arc::clone(&runner) as Arc<dyn TurnRunner>;
        let builder = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("turn-detached")),
                ..ServerOptions::default()
            },
        );
        let _ = runner.hub.set(builder.events());
        let (router, state) = builder.into_router(3082).expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/turn")
                    .header("cookie", &cookie)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"prompt":"weave"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // The page reloads: the response is dropped before the turn says anything.
        drop(response);
        runner.release.notify_one();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !runner.finished.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "the turn was cancelled when its reader went away"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // And once it has finished, the session is no longer running and its completion is recorded.
        let session = state.harness().sessions.list()[0].id.clone();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while state.runs().is_running(&session) {
            assert!(
                std::time::Instant::now() < deadline,
                "the session stayed running"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(state.runs().completed_at(&session).is_some());
    }

    #[tokio::test]
    async fn a_turn_in_a_folder_runs_without_a_workspace_service() {
        // web.ts opens the folder's session and adopts the folder; no workspace has to own it first,
        // and a profile without the workspace row can still run a turn in a folder.
        let hub = Arc::new(std::sync::OnceLock::new());
        let runner = Arc::new(StreamingTurns {
            hub: Arc::clone(&hub),
            text: "hello".into(),
        });
        let (router, _) = app_with_runner("turn-folder", runner);
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let folder = std::env::temp_dir();
        let body = serde_json::json!({"prompt": "work in the loose folder", "folder": folder});
        let (status, bytes) = post_json(&router, "/api/turn", &cookie, &body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
        assert!(body_text(&bytes).contains("event: done"));
    }

    #[tokio::test]
    async fn a_turn_streams_its_sessions_events_and_ends_with_done() {
        let hub = Arc::new(std::sync::OnceLock::new());
        let runner = Arc::new(StreamingTurns {
            hub: Arc::clone(&hub),
            text: "hello".into(),
        });
        let (router, _) = app_with_runner("turn-stream", runner);
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let (status, bytes) =
            post_json(&router, "/api/turn", &cookie, r#"{"prompt":"say hello"}"#).await;
        assert_eq!(status, StatusCode::OK);
        let text = body_text(&bytes);
        assert!(text.starts_with(": heddle stream open\n\n"), "{text}");
        assert!(text.contains("event: session\n"), "{text}");
        assert!(
            text.contains(r#""type":"text-delta""#) && text.contains(r#""text":"hello""#),
            "{text}"
        );
        assert!(text.contains("event: done\n"), "{text}");
        let session_at = text.find("event: session").unwrap();
        let done_at = text.find("event: done").unwrap();
        assert!(
            session_at < done_at,
            "the event arrives before the terminal frame"
        );
    }

    #[tokio::test]
    async fn a_stalled_live_reader_does_not_hold_back_done() {
        // web.ts writes `done` when the turn ends, whatever its `/api/events` responses have taken, so a client
        // that never reads its live stream holds back no turn's terminal frame (80 check-chat-view #16).
        let runner = Arc::new(StreamingTurns {
            hub: Arc::new(std::sync::OnceLock::new()),
            text: "x".into(),
        });
        let (router, state) = app_with_runner("turn-stalled", Arc::clone(&runner));
        let _stalled = state.events().subscribe();
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let started = std::time::Instant::now();
        let (status, body) = post_json(&router, "/api/turn", &cookie, r#"{"prompt":"go"}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert!(String::from_utf8_lossy(&body).contains("event: done"));
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "a stalled reader held done for {:?}",
            started.elapsed()
        );
        let session = state
            .harness()
            .sessions
            .list()
            .first()
            .expect("the turn made a session")
            .id
            .clone();
        assert!(!state.runs().is_running(&session));
    }

    #[tokio::test]
    async fn a_stop_cancels_the_running_turn() {
        let (router, state) = app("stop");
        let id = "session-00000000-0000-0000-0000-000000000001";
        let guard = state.runs().begin(id);
        assert!(state.runs().is_running(id));
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let (status, bytes) =
            post_json(&router, &format!("/api/sessions/{id}/stop"), &cookie, "{}").await;
        assert_eq!(status, StatusCode::OK);
        let text = body_text(&bytes);
        assert!(text.contains("\"stopped\": 1"), "{text}");
        assert!(text.contains(id), "{text}");
        assert!(guard.is_cancelled(), "the turn's token is cancelled");
        drop(guard);
    }

    /// One raw HTTP/1.1 exchange, because the verifiers speak over a socket rather than through
    /// `tower::ServiceExt`: the door's handshake and the refusal headers are judged on the wire.
    async fn raw_request(port: u16, request: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("a connection to the test server");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buffer = Vec::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.read_to_end(&mut buffer),
        )
        .await;
        String::from_utf8_lossy(&buffer).into_owned()
    }

    #[tokio::test]
    async fn every_accepted_connection_has_nagle_off_as_node_s_server_does() {
        use axum::serve::Listener;
        // A plain accept keeps Nagle on, so the check below can tell the two apart.
        let plain = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = plain.local_addr().unwrap().port();
        let _client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let (stream, _) = plain.accept().await.unwrap();
        assert!(!stream.nodelay().unwrap());

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut served = without_nagle(listener);
        let _client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let (stream, _) = served.accept().await;
        assert!(
            stream.nodelay().unwrap(),
            "the served connection keeps Nagle on"
        );
    }

    #[tokio::test]
    async fn the_door_behaves_the_same_over_a_real_socket() {
        let server = ServerBuilder::new(
            harness(),
            ServerOptions {
                port: Some(0),
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("socket")),
                ..ServerOptions::default()
            },
        )
        .start()
        .await
        .expect("the server starts");
        let port = server.port();

        let health = raw_request(
            port,
            "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(health.starts_with("HTTP/1.1 200"), "{health}");
        assert!(health.contains(r#""service":"heddle-web""#), "{health}");

        let refused = raw_request(
            port,
            "GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(refused.starts_with("HTTP/1.1 401"), "{refused}");
        assert!(refused.ends_with("unauthorized\n"), "{refused}");

        let handshake = raw_request(
            port,
            "GET /?token=test-token HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(handshake.starts_with("HTTP/1.1 303"), "{handshake}");
        assert!(handshake.contains("HttpOnly"), "{handshake}");
        let cookie = handshake
            .lines()
            .find_map(|line| line.strip_prefix("set-cookie: "))
            .and_then(|value| value.split(';').next())
            .expect("the handshake set a cookie")
            .to_owned();

        let served = raw_request(
            port,
            &format!(
                "GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(served.starts_with("HTTP/1.1 200"), "{served}");

        let fenced = raw_request(
            port,
            "GET /api/sessions HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(fenced.starts_with("HTTP/1.1 403"), "{fenced}");

        server.close().await;
    }

    #[tokio::test]
    async fn the_sanitiser_is_javascript_or_a_plain_404() {
        // Not installed: the TypeScript sentence, in plain text rather than a JSON error.
        let (router, _) = app("purify-missing");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, headers, bytes) =
            call(&router, Method::GET, "/vendor/purify.js", Some(&cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(headers["content-type"], "text/plain");
        assert_eq!(body_text(&bytes), "the sanitiser is not installed\n");

        // Installed under an asset root: served as a script a browser will run, not as a download.
        let root = std::env::temp_dir().join(format!(
            "heddle-purify-route-{}-{}",
            std::process::id(),
            token::now_ms()
        ));
        let nested = root.join("node_modules").join("dompurify").join("dist");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("purify.min.js"), "// purify").unwrap();
        let builder = ServerBuilder::new(
            harness(),
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("purify-installed")),
                asset_roots: vec![root.clone()],
                ..ServerOptions::default()
            },
        );
        let (router, _) = builder.into_router(3082).expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, headers, bytes) =
            call(&router, Method::GET, "/vendor/purify.js", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "text/javascript; charset=utf-8");
        assert_eq!(headers["cache-control"], "no-store");
        assert_eq!(body_text(&bytes), "// purify");
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn an_unanswerable_approval_and_an_html_path_without_a_workspace_are_refusals_not_plugin_errors()
     {
        let mut without_approvals = harness();
        without_approvals.approvals = None;
        let builder = ServerBuilder::new(
            without_approvals,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("without-plugins")),
                ..ServerOptions::default()
            },
        );
        let (router, _) = builder.into_router(3082).expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let (status, bytes) = post_json(
            &router,
            "/api/approvals/approval-00000000-0000-0000-0000-000000000000",
            &cookie,
            r#"{"outcome":"allowed-once"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let body = body_text(&bytes);
        assert!(body.contains("no longer waiting"), "{body}");
        assert!(body.contains("\"answered\": false"), "{body}");

        // The id's shape and the outcome are checked before the service, as web.ts orders them.
        let (status, bytes) = post_json(
            &router,
            "/api/approvals/not-an-approval",
            &cookie,
            r#"{"outcome":"allowed-once"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body_text(&bytes), "{\"error\":\"not an approval id\"}\n");

        // No workspace service: /api/html reports the path as outside every root, as web.ts does.
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/html?path=%2Fwork%2Fa.html")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            body_text(&bytes),
            "{\"error\":\"that path is not under any workspace root\"}\n"
        );
    }

    #[tokio::test]
    async fn a_state_applied_router_mounts_behind_the_door() {
        let mounted = Router::<()>::new().route("/api/hello", get(|| async { "hi" }));
        let builder = ServerBuilder::new(
            harness(),
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("mounted-router")),
                ..ServerOptions::default()
            },
        )
        .mount_router(mounted);
        let (router, _) = builder.into_router(3082).expect("the test router");

        let (status, _, _) = call(&router, Method::GET, "/api/hello", None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "a mounted route is behind the token"
        );

        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(&router, Method::GET, "/api/hello", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body_text(&bytes), "hi");
    }

    #[test]
    fn a_state_applied_router_claiming_a_core_route_is_a_startup_error() {
        let mounted = Router::<()>::new().route("/healthz", get(|| async { "mine" }));
        let builder = ServerBuilder::new(
            harness(),
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("mounted-conflict")),
                ..ServerOptions::default()
            },
        )
        .mount_router(mounted);
        match builder.into_router(3082).err().expect("a refusal") {
            ServerError::Route(message) => {
                assert!(message.contains("mounted router"), "{message}");
                assert!(message.contains("/healthz"), "{message}");
            }
            other => panic!("expected a route conflict, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_wrong_method_is_the_typescript_not_found() {
        let (router, _) = app("method");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::GET)
                    .uri("/api/turn")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body_text(&bytes), "not found\n");
    }

    /// `/api/events` opens with its comment and then DSH's `ready` frame, and a frame published after the
    /// subscription was registered (before any byte was read) arrives after `ready`, not lost.
    #[tokio::test]
    async fn the_event_stream_opens_with_ready_and_then_carries_what_is_published() {
        use http_body_util::BodyExt;
        let (router, state) = app("events-ready");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::GET)
                    .uri("/api/events")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        state
            .events()
            .publish_session_event("session-1", &serde_json::json!({"type": "message"}));
        let mut text = String::new();
        while !text.contains("event: session\n") {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
                .await
                .expect("a frame in time")
                .expect("the stream stays open")
                .expect("a body frame");
            if let Ok(data) = frame.into_data() {
                text.push_str(&String::from_utf8_lossy(&data));
            }
        }
        assert!(text.starts_with(": heddle stream open\n\n"), "{text}");
        let rest = &text[": heddle stream open\n\n".len()..];
        assert!(rest.starts_with("event: ready\ndata: "), "{text}");
        let data: Value = serde_json::from_str(
            rest.lines().nth(1).unwrap().trim_start_matches("data: "),
        )
        .unwrap();
        assert_eq!(data["type"], "ready");
        let client = data["clientId"].as_str().unwrap();
        assert!(client.len() == 32 && client.chars().all(|c| c.is_ascii_hexdigit()), "{client}");
        assert_eq!(data["host"]["home"], std::env::var("HOME").unwrap_or_default());
        assert!(rest.find("event: ready").unwrap() < rest.find("event: session").unwrap(), "{text}");
    }

    /// A reconnect with `Last-Event-ID` is given the frames it missed after `ready`; a cursor from another
    /// server start is given `reset`.
    #[tokio::test]
    async fn the_event_stream_replays_after_a_cursor_and_resets_an_unknown_one() {
        use http_body_util::BodyExt;
        let (router, state) = app("events-follow");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        state.events().publish_session_event("session-1", &serde_json::json!({"n": 1}));
        let seen = state.events().cursor();
        state.events().publish_session_event("session-1", &serde_json::json!({"n": 2}));
        async fn read_until(router: &Router, cookie: &str, cursor: &str, marker: &str) -> String {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(Method::GET)
                        .uri("/api/events")
                        .header("cookie", cookie)
                        .header("last-event-id", cursor)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let mut body = response.into_body();
            let mut text = String::new();
            while !text.contains(marker) {
                let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
                    .await
                    .expect("a frame in time")
                    .expect("the stream stays open")
                    .expect("a body frame");
                if let Ok(data) = frame.into_data() {
                    text.push_str(&String::from_utf8_lossy(&data));
                }
            }
            text
        }
        let text = read_until(&router, &cookie, &seen, "\"n\":2").await;
        assert!(text.contains("\"resumed\":true"), "{text}");
        assert!(!text.contains("\"n\":1"), "nothing before the cursor is repeated: {text}");
        assert!(text.find("event: ready").unwrap() < text.find("\"n\":2").unwrap(), "{text}");
        let text = read_until(&router, &cookie, "0000-1", "event: reset").await;
        assert!(text.contains("\"resumed\":false"), "{text}");
    }

    /// An approval double whose questions are always waiting, so an answer settles one.
    struct AnsweringApprovals;

    impl ApprovalService for AnsweringApprovals {
        fn attach_answerer(&self) -> Box<dyn FnOnce() + Send> {
            Box::new(|| {})
        }
        fn pending_requests(&self) -> Vec<Value> {
            Vec::new()
        }
        fn answer(&self, _id: &str, _outcome: ApprovalOutcome) -> bool {
            true
        }
    }

    /// A workspace double whose add creates, whose rename finds and whose remove succeeds.
    struct EditableWorkspaces;

    impl crate::services::WorkspaceService for EditableWorkspaces {
        fn owns(&self, _path: &std::path::Path) -> bool {
            true
        }
        fn tree(
            &self,
            _path: Option<&std::path::Path>,
            _archived: crate::services::ArchivedFilter,
            _sessions: &[SessionMeta],
        ) -> Result<Value, ServiceError> {
            Ok(json!({}))
        }
        fn add(
            &self,
            path: &std::path::Path,
            _name: Option<&str>,
        ) -> Result<(Value, bool), ServiceError> {
            Ok((json!({"id": "w-2", "path": path, "title": "added"}), true))
        }
        fn find(&self, _id: &str) -> bool {
            true
        }
        fn remove(&self, _id: &str, _sessions: &[SessionMeta]) -> Result<Value, ServiceError> {
            Ok(json!({"removed": true}))
        }
        fn rename(&self, id: &str, title: &str) -> Result<Option<Value>, ServiceError> {
            Ok(Some(json!({"id": id, "title": title})))
        }
        fn ensure_owner(&self, _folder: &std::path::Path) {}
        fn views(&self, _sessions: &[SessionMeta]) -> Result<Value, ServiceError> {
            Ok(json!([]))
        }
    }

    /// The next frame a subscription holds, as `(event, data)`, within a second.
    async fn next_pushed(subscription: &mut crate::stream::Subscription) -> (String, Value, Option<String>) {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), subscription.next_frame())
            .await
            .expect("a frame in time")
            .expect("the hub is open");
        (frame.event, serde_json::from_str(&frame.data).unwrap(), frame.id)
    }

    /// The changes that never reach a session's log are pushed to the stream, numbered like every frame:
    /// a renamed session, an added, renamed and removed workspace, and a settled approval (phase B item 4).
    #[tokio::test]
    async fn renames_workspace_edits_and_settled_approvals_are_pushed() {
        let mut with_services = harness();
        with_services.workspaces = Some(Arc::new(EditableWorkspaces));
        with_services.approvals = Some(Arc::new(AnsweringApprovals));
        let (router, state) = ServerBuilder::new(
            with_services,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("pushes")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let mut pushed = state.events().subscribe();
        let session = "session-00000000-0000-0000-0000-000000000001";

        let (status, _) = post_json(&router, &format!("/api/sessions/{session}/title"), &cookie, r#"{"title":"renamed"}"#).await;
        assert_eq!(status, StatusCode::OK);
        let (event, data, id) = next_pushed(&mut pushed).await;
        assert_eq!(event, "sessions");
        assert_eq!(data, json!({"type": "session/renamed", "session": session, "title": "renamed"}));
        assert!(id.is_some(), "a push is numbered, so it is replayed to a reconnecting client");

        let folder = std::env::temp_dir();
        let body = json!({"path": folder}).to_string();
        let (status, _) = post_json(&router, "/api/workspaces", &cookie, &body).await;
        assert_eq!(status, StatusCode::OK);
        let (event, data, _) = next_pushed(&mut pushed).await;
        assert_eq!((event.as_str(), data["type"].as_str()), ("workspace", Some("workspace/added")));

        for (method, expected) in [(Method::PATCH, "workspace/renamed"), (Method::DELETE, "workspace/removed")] {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri("/api/workspaces/w-2")
                        .header("cookie", &cookie)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"title":"retitled"}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let (event, data, _) = next_pushed(&mut pushed).await;
            assert_eq!((event.as_str(), data["type"].as_str()), ("workspace", Some(expected)));
        }

        let (status, _) = post_json(
            &router,
            "/api/approvals/approval-00000000-0000-0000-0000-000000000000",
            &cookie,
            r#"{"outcome":"rejected"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (event, data, _) = next_pushed(&mut pushed).await;
        assert_eq!(event, "approval-settled");
        assert_eq!(
            data,
            json!({"type": "approval/settled", "id": "approval-00000000-0000-0000-0000-000000000000", "outcome": "rejected"})
        );
    }

    /// A runner whose turn fails, as a provider's 502 does.
    struct FailingTurns;

    impl TurnRunner for FailingTurns {
        fn run_turn(
            &self,
            _request: TurnRequest,
        ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
            Box::pin(async { Err(ServiceError::new("upstream answered 502")) })
        }
    }

    /// A failed turn tells the client that started it and is recorded as `turn/failed`, so it reaches every
    /// client and every later read (R-developer-six-2).
    #[tokio::test]
    async fn a_failed_turn_is_recorded_for_every_client_as_well_as_streamed_to_its_own() {
        let sessions = Arc::new(Sessions::with_one());
        let mut failing = Harness::new(
            sessions.clone(),
            Arc::new(Models),
            Arc::new(FailingTurns),
            Arc::new(Sandbox),
            PathBuf::from("/work"),
        );
        failing.approvals = Some(Arc::new(Approvals));
        let (router, _) = ServerBuilder::new(
            failing,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("turn-failed")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let session = "session-00000000-0000-0000-0000-000000000001";
        let body = json!({"prompt": "fail please", "session": session}).to_string();
        let (status, bytes) = post_json(&router, "/api/turn", &cookie, &body).await;
        assert_eq!(status, StatusCode::OK);
        let text = body_text(&bytes);
        assert!(text.contains("event: error\n") && text.contains("upstream answered 502"), "{text}");
        let recorded = sessions.recorded.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![(session.to_owned(), "turn/failed".to_owned(), json!({"message": "upstream answered 502"}))]
        );
    }

    /// Every route in [`CORE_ROUTES`] answers as a route rather than as the fallback.
    ///
    /// The table is what feature crates and the binary consult; a typo in it would otherwise be
    /// invisible until a verifier asked. A service route may legitimately answer 404 with a JSON
    /// body (`no session …`), so the assertion is that the answer is not the plain-text fallback.
    #[tokio::test]
    async fn every_core_route_is_registered() {
        let (router, _) = app("core-routes");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let session = "session-00000000-0000-0000-0000-000000000001";
        for (method, path) in CORE_ROUTES {
            if *path == "/api/events" {
                // An SSE response stays open by design, so it is not read to its end here; its
                // presence is covered by the door and stream tests.
                continue;
            }
            let path = if *path == "/api/approvals/{id}" {
                path.replace("{id}", "approval-00000000-0000-0000-0000-000000000000")
            } else if *path == "/api/workspaces/{id}" {
                path.replace("{id}", "workspace")
            } else {
                path.replace("{id}", session)
            };
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(Method::from_bytes(method.as_bytes()).unwrap())
                        .uri(&path)
                        .header("cookie", &cookie)
                        .header("content-type", "application/json")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let body = body_text(&bytes);
            assert_ne!(
                status,
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {path} is not registered"
            );
            assert_ne!(
                body, "not found\n",
                "{method} {path} fell through to the fallback"
            );
        }
    }

    struct BrokenTeam;

    impl crate::services::TeamService for BrokenTeam {
        fn view(&self, _session: &str) -> Result<crate::services::TeamView, ServiceError> {
            Err(ServiceError::with_code(
                "member alpha is active without provisioning",
                "TEAM_MEMBER_PHASE",
            ))
        }
    }

    struct WorkingTeam;

    impl crate::services::TeamService for WorkingTeam {
        fn view(&self, _session: &str) -> Result<crate::services::TeamView, ServiceError> {
            Ok(crate::services::TeamView {
                lead: serde_json::json!("lead"),
                members: serde_json::json!([{"name": "lead", "role": "lead", "status": "inactive"}]),
                tasks: serde_json::json!([]),
                messages: serde_json::json!([]),
                delivered: serde_json::json!([]),
            })
        }
    }

    async fn team_answer(
        team: Arc<dyn crate::services::TeamService>,
        label: &str,
    ) -> (StatusCode, String) {
        let mut harness = harness();
        harness.team = Some(team);
        let builder = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret(label)),
                ..ServerOptions::default()
            },
        );
        let (router, _) = builder.into_router(3082).expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(
            &router,
            Method::GET,
            "/api/team?session=session-00000000-0000-0000-0000-000000000001",
            Some(&cookie),
        )
        .await;
        (status, body_text(&bytes))
    }

    #[tokio::test]
    async fn a_refused_team_fold_is_the_typescript_internal_error() {
        let (status, body) = team_answer(Arc::new(BrokenTeam), "team-broken").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body,
            "internal error: member alpha is active without provisioning\n"
        );

        let (status, body) = team_answer(Arc::new(WorkingTeam), "team-working").await;
        assert_eq!(status, StatusCode::OK);
        let view: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(view["lead"], "lead");
        assert_eq!(view["members"][0]["role"], "lead");
    }

    struct PanickingFeature;

    impl Feature for PanickingFeature {
        fn name(&self) -> &'static str {
            "panicking"
        }

        fn routes(&self) -> Router<AppState> {
            Router::new().route(
                "/api/boom",
                get(|| async {
                    panic!("the boom route failed");
                    #[allow(unreachable_code)]
                    ""
                }),
            )
        }
    }

    #[tokio::test]
    async fn a_panicking_route_answers_500_instead_of_dropping_the_connection() {
        let builder = ServerBuilder::new(
            harness(),
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("panic")),
                ..ServerOptions::default()
            },
        )
        .mount(PanickingFeature);
        let (router, _) = builder.into_router(3082).expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(&router, Method::GET, "/api/boom", Some(&cookie)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body_text(&bytes), "internal error: the boom route failed\n");
        // The router keeps answering after the panic.
        let (status, _, _) = call(&router, Method::GET, "/healthz", None).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// The routes over the real session store: what the store records is what the chat view draws,
    /// and the store's own events reach the hub the server streams from.
    #[tokio::test]
    async fn the_routes_read_a_real_session_store() {
        use crate::adapters::{StoreSessions, session_event_listener};
        use crate::services::SessionService as _;

        let scratch = std::env::temp_dir().join(format!(
            "heddle-server-store-routes-{}-{}",
            std::process::id(),
            token::now_ms()
        ));
        std::fs::create_dir_all(&scratch).unwrap();
        let scratch = std::fs::canonicalize(&scratch).unwrap();

        let hub = EventHub::new();
        let sessions = StoreSessions::new(heddle_session::SessionService::new(
            &heddle_session::SessionConfig {
                root: Some(scratch.join("sessions").to_string_lossy().into_owned()),
            },
            &heddle_config::Env::default(),
            Some(session_event_listener(hub.clone())),
        ));
        let harness = Harness::new(
            Arc::new(sessions.clone()),
            Arc::new(Models),
            Arc::new(Turns),
            Arc::new(Sandbox),
            scratch.clone(),
        );
        let builder = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("store-routes")),
                ..ServerOptions::default()
            },
        )
        .with_event_hub(hub.clone());
        let (router, state) = builder.into_router(3082).expect("the test router");
        let mut frames = state.events().subscribe();

        let id = sessions
            .start(StartSession {
                cwd: Some(scratch.clone()),
                ..StartSession::default()
            })
            .unwrap();
        sessions
            .user_content(
                &id,
                vec![serde_json::json!({"type": "text", "text": "remember the word loom"})],
            )
            .unwrap();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), frames.next_frame())
            .await
            .expect("the store's event reached the server's hub")
            .expect("the hub is open");
        assert_eq!(frame.session_id().as_deref(), Some(id.as_str()));

        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(&router, Method::GET, "/api/sessions", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        let listed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(listed[0]["id"], id.as_str());
        assert_eq!(listed[0]["running"], false);

        let (status, _, bytes) = call(
            &router,
            Method::GET,
            &format!("/api/sessions/{id}"),
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let view: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(view["id"], id.as_str());
        assert_eq!(view["permission"]["mode"], "workspace-write");
        let turns = view["turns"].as_array().unwrap();
        assert!(
            turns
                .iter()
                .any(|turn| turn["kind"] == "user" && turn["text"] == "remember the word loom"),
            "{turns:?}"
        );
        std::fs::remove_dir_all(&scratch).ok();
    }

    struct DuplicateFeature;

    impl Feature for DuplicateFeature {
        fn name(&self) -> &'static str {
            "duplicate"
        }

        fn routes(&self) -> Router<AppState> {
            Router::new().route("/healthz", get(|| async { "mine" }))
        }
    }

    #[test]
    fn a_feature_claiming_a_core_route_is_a_startup_error() {
        let builder = ServerBuilder::new(
            harness(),
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("conflict")),
                ..ServerOptions::default()
            },
        )
        .mount(DuplicateFeature);
        let error = builder
            .into_router(3082)
            .err()
            .expect("a route conflict is refused");
        match error {
            ServerError::Route(message) => {
                assert!(message.contains("duplicate"), "{message}");
                assert!(message.contains("/healthz"), "{message}");
            }
            other => panic!("expected a route conflict, got {other:?}"),
        }
    }

    // `to_bytes` is used by `call`'s siblings in other modules; the import is kept explicit here.
    #[allow(dead_code)]
    async fn _body(response: Response) -> Vec<u8> {
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }
}
