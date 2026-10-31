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
use axum::http::{HeaderMap, Method, StatusCode, header, header::HOST};
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
use crate::terminals::{
    CreateRefusal, InputResult, ResizeResult, TerminalEvent, TerminalRegistry, TerminalSpawn,
};
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
    ("GET", "/api/presets"),
    ("GET", "/api/sessions"),
    ("POST", "/api/sessions"),
    ("GET", "/api/sessions/search"),
    ("GET", "/api/sessions/{id}"),
    ("POST", "/api/sessions/{id}/fork"),
    ("POST", "/api/sessions/{id}/flags"),
    ("POST", "/api/sessions/{id}/title"),
    ("POST", "/api/sessions/{id}/permission"),
    ("POST", "/api/sessions/{id}/steer"),
    ("POST", "/api/sessions/{id}/stop"),
    ("GET", "/api/sessions/{id}/terminals"),
    ("POST", "/api/sessions/{id}/terminals"),
    ("DELETE", "/api/sessions/{id}/terminals/{terminal}"),
    ("GET", "/api/sessions/{id}/terminals/{terminal}/stream"),
    ("POST", "/api/sessions/{id}/terminals/{terminal}/input"),
    ("POST", "/api/sessions/{id}/terminals/{terminal}/resize"),
    ("POST", "/api/folders/session"),
    ("POST", "/api/turn"),
    ("GET", "/api/tree"),
    ("GET", "/api/workspaces"),
    ("POST", "/api/workspaces"),
    ("PATCH", "/api/workspaces/{id}"),
    ("DELETE", "/api/workspaces/{id}"),
    ("POST", "/api/workspaces/insertBefore"),
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
    /// The page's interactive terminals, per session (#85).
    terminals: TerminalRegistry,
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

    /// Each session's interactive terminals (#85).
    pub fn terminals(&self) -> &TerminalRegistry {
        &self.inner.terminals
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
                terminals: TerminalRegistry::default(),
            }),
        };

        let mut router = Router::new()
            .route("/favicon.svg", get(favicon))
            .route("/favicon.ico", get(favicon))
            .route("/healthz", get(healthz))
            .route("/", get(page_route))
            .route("/api/events", get(events_route))
            .route("/api/status", get(status))
            .route("/api/presets", get(list_presets))
            .route("/api/sessions", get(list_sessions).post(create_session))
            .route("/api/sessions/search", get(search_sessions))
            .route("/api/sessions/{id}", get(session_view_route))
            .route("/api/sessions/{id}/fork", post(fork_session))
            .route("/api/sessions/{id}/flags", post(flags_session))
            .route("/api/sessions/{id}/title", post(title_session))
            .route("/api/sessions/{id}/permission", post(permission_session))
            .route("/api/sessions/{id}/steer", post(steer_session))
            .route("/api/sessions/{id}/stop", post(stop_session))
            .route(
                "/api/sessions/{id}/terminals",
                get(list_terminals).post(create_terminal),
            )
            .route(
                "/api/sessions/{id}/terminals/{terminal}",
                delete(close_terminal),
            )
            .route(
                "/api/sessions/{id}/terminals/{terminal}/stream",
                get(stream_terminal),
            )
            .route(
                "/api/sessions/{id}/terminals/{terminal}/input",
                post(input_terminal),
            )
            .route(
                "/api/sessions/{id}/terminals/{terminal}/resize",
                post(resize_terminal),
            )
            .route("/api/folders/session", post(folder_session))
            .route("/api/turn", post(turn))
            .route("/api/tree", get(tree))
            .route("/api/workspaces", get(list_workspaces).post(add_workspace))
            .route("/api/workspaces/{id}", patch(rename_workspace))
            .route("/api/workspaces/{id}", delete(remove_workspace))
            .route(
                "/api/workspaces/insertBefore",
                post(insert_workspace_before),
            )
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
            let listener =
                crate::stall::GuardedListener::new(without_nagle(listener), interval * 2);
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

/// How long a shutdown waits for stopped turns to settle: DSH's 3 s kill grace plus room to write the results.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

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
        // A restart stops the running turns first, as a Stop does, and gives them DSH's grace to settle, so each
        // running command's process group is ended and its call is recorded as interrupted before the process
        // goes (live-testing issue #6; DSH cancels its agents at teardown, dsh-bash-local graceMs 3000).
        let runs = self.state.runs().clone();
        if runs.abort_all() > 0 {
            let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
            while runs.any_running() && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
        // Then the terminals end, and their processes with them, so a restart leaves no orphan shell (#85). After the
        // turns' grace, so a terminal opened during it is ended too.
        self.state.terminals().close_all().await;
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
            let lang = page_language(&state, request.headers());
            return respond::html(StatusCode::OK, page::with_language(page::page(), lang));
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

async fn page_route(State(state): State<AppState>, headers: HeaderMap) -> Response {
    respond::html(
        StatusCode::OK,
        page::with_language(page::page(), page_language(&state, &headers)),
    )
}

/// The served page's `<html lang>` (issue #80): the language the `locale` row stores, else the first supported one
/// the browser's `Accept-Language` asks for, else English, as DSH's dsh-client-locale selects it; Chinese is `zh-CN`.
fn page_language(state: &AppState, headers: &HeaderMap) -> &'static str {
    let accept = headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok());
    let locale = state
        .harness()
        .locale
        .unwrap_or_default()
        .for_request(accept);
    heddle_config::document_language(locale)
}

async fn events_route(State(state): State<AppState>) -> Response {
    // Subscribed before the body starts, so `ready` is followed by every frame published after it.
    let subscription = state.events().subscribe();
    sse_response(stream::events_frames(
        subscription,
        &stream::new_client_id(),
        &stream::host_home(),
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

/// `GET /api/sessions/search?q=` — content search, DSH's `session.search` (dsh-api-session-controller
/// lib/index.js:2010-2123): `{"items":[{"sessionId","snippet"}],"hasMore"}`, at most 20, ranked and quoted by
/// `heddle_session::search`. A query DSH refuses answers `400` with its sentence. The static segment wins over
/// `/api/sessions/{id}`, which would otherwise answer it as "not a session id".
async fn search_sessions(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let raw = params.get("q").map(String::as_str).unwrap_or("");
    let query = match heddle_session::normalize_search_query(raw) {
        Ok(query) => query,
        Err(refusal) => return respond::error(StatusCode::BAD_REQUEST, refusal.message),
    };
    match state.harness().sessions.search(&query) {
        Ok(page) => respond::json(StatusCode::OK, &page),
        Err(error) => respond::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("session search failed: {}", error.message),
        ),
    }
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

/// The roster requests are checked against, and whether it is the implicit one of a profile without the `presets` row
/// (inventory A96), which declares only `standard`.
fn preset_roster_of(state: &AppState) -> (heddle_config::PresetRoster, bool) {
    match state.harness().presets.as_ref() {
        Some(roster) => ((**roster).clone(), false),
        None => (
            heddle_config::preset_roster(None).unwrap_or_else(|_| heddle_config::PresetRoster {
                default: heddle_config::standard_preset().id,
                presets: vec![heddle_config::standard_preset()],
            }),
            true,
        ),
    }
}

/// `GET /api/presets` (inventory A96): DSH's `agentPresets/list`, the roster and its default, for the new-session
/// picker and the Settings roster. Each preset says what it narrows: the tools its sessions are offered (absent means
/// every tool) and its persona. A profile without the `presets` row answers its one implicit preset, marked so.
async fn list_presets(State(state): State<AppState>) -> Response {
    let (roster, implicit) = preset_roster_of(&state);
    let mut body = Map::new();
    body.insert("default".into(), Value::String(roster.default));
    body.insert(
        "presets".into(),
        serde_json::to_value(&roster.presets).unwrap_or(Value::Array(Vec::new())),
    );
    if implicit {
        body.insert("implicit".into(), Value::Bool(true));
    }
    respond::json(StatusCode::OK, &Value::Object(body))
}

/// The agent preset a request names (inventory A96), checked before anything is written: `Ok(None)` when it names
/// none (absent, not a string, or blank), the declared id, or the sentence a `400` answers — DSH's
/// dsh-agent-preset-registry `Unknown agent preset: <id>`, with what is declared.
fn requested_preset(state: &AppState, body: &JsonBody) -> Result<Option<String>, String> {
    let Some(wanted) = body.trimmed("preset") else {
        return Ok(None);
    };
    let declared = preset_roster_of(state).0.ids();
    if !declared.iter().any(|id| id == wanted) {
        return Err(format!(
            "Unknown agent preset: {wanted}; declared: {}",
            declared.join(", ")
        ));
    }
    Ok(Some(wanted.to_owned()))
}

/// The `409` for another preset named for a session that recorded one: a session keeps the preset it was created with.
fn preset_fixed(recorded: &str) -> Response {
    respond::error_with_code(
        StatusCode::CONFLICT,
        format!(
            "the session runs the preset '{recorded}'; a session keeps the preset it was created with"
        ),
        "session/preset-fixed",
    )
}

/// The preset a new session is created under: the one the request named, else the profile's default (none for a
/// profile without the `presets` row).
fn new_session_preset(state: &AppState, named: Option<&str>) -> Option<String> {
    named.map(str::to_owned).or_else(|| {
        state
            .harness()
            .presets
            .as_ref()
            .map(|roster| roster.default.clone())
    })
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
    let named = match requested_preset(&state, &body) {
        Ok(named) => named,
        Err(refusal) => return respond::error(StatusCode::BAD_REQUEST, refusal),
    };
    let preset = new_session_preset(&state, named.as_deref());
    match state
        .harness()
        .sessions
        .create_at(&branch, body.non_empty("title"), preset.as_deref())
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
        preset: None,
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
    // The agent preset the session runs under (inventory A96); `null` until a turn records one.
    body.insert(
        "preset".into(),
        meta.as_ref()
            .and_then(|meta| meta.preset())
            .map(|preset| Value::String(preset.to_owned()))
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
        Ok(Some(meta)) => {
            // Archiving ends the session's terminals and their processes, as DSH's session-owned terminals end
            // with their owner (#85).
            if archived == Some(true) {
                state.terminals().close_session(id.as_str()).await;
            }
            respond::json(StatusCode::OK, &meta)
        }
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
    // A title with nothing visible left once cleaned is refused, as DSH's rename refuses it
    // (`dsh-session-title` lib/index.js:298-299; `dsh-api-session-controller` lib/index.js:838); the
    // store cleans what it accepts (`heddle_session::title_text`). An unknown session is still a `404`
    // first, as DSH resolves the session before it judges the title.
    if heddle_session::title_text::clean_session_title(&title).is_empty() {
        if !state.harness().sessions.exists(id.as_str()) {
            return respond::no_session(id.as_str());
        }
        return respond::error_with_code(
            StatusCode::BAD_REQUEST,
            heddle_session::title_text::TITLE_INVALID_MESSAGE,
            heddle_session::title_text::TITLE_INVALID_CODE,
        );
    }
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
                // A terminal is confined by the mode it was opened under, and a mode change (a narrowing above all)
                // must not leave a wider shell running, so the session's terminals end with the change (#85).
                if written.changed {
                    state.terminals().close_session(id.as_str()).await;
                }
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
    // Every turn of the session, not only the ones this server started (#93): a goal round, a reminder's turn and a
    // job notice's turn are registered with the agent runtime's live-turn registry, not with `runs`. A turn the
    // server started is in both and is counted once.
    let live = state
        .harness()
        .interrupter
        .as_ref()
        .is_some_and(|interrupter| interrupter.interrupt(id.as_str()));
    let stopped = state.runs().abort(id.as_str()).max(usize::from(live));
    respond::json(
        StatusCode::OK,
        &json!({"stopped": stopped, "session": id.to_string()}),
    )
}

/// One level of the folder tree (web.ts's `GET /api/tree`): the registered roots without a `path`,
/// else the children of `path` — and only when a registered root owns it. A path outside every root
/// is refused with web.ts's `400 {"error": "<canonical> is not under any workspace root"}` before
/// anything is read, as the CLI's `tree` and the file routes refuse it. The path is canonical
/// first, so `..` and a symlink that leads out of a root are judged where they land. An empty
/// `path` is the roots, as in web.ts.
async fn tree(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let path = query
        .get("path")
        .filter(|path| !path.is_empty())
        .map(canonical_path);
    if let Some(path) = path.as_deref().filter(|path| !workspaces.owns(path)) {
        return respond::error(
            StatusCode::BAD_REQUEST,
            format!("{} is not under any workspace root", path.display()),
        );
    }
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
        Ok((record, created)) => respond::json(
            StatusCode::OK,
            &json!({"record": record, "created": created}),
        ),
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
        Ok(Some(record)) => respond::json(StatusCode::OK, &record),
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
        Ok(outcome) => respond::json(StatusCode::OK, &outcome),
        Err(error) => service_refusal(error, StatusCode::CONFLICT),
    }
}

/// Move a workspace in the stored order — DSH's `workspace/insertBefore` (dsh-api-workspace-controller
/// lib/index.js:262-269), web.ts's `POST /api/workspaces/insertBefore`: `{workspaceId, beforeWorkspaceId?}`
/// (an id or a path each), answered `{workspaceIds}`, the complete order; a workspace or anchor not in the
/// order is `404 workspace/not-found` with DSH's sentence.
async fn insert_workspace_before(State(state): State<AppState>, body: JsonBody) -> Response {
    let Some(workspaces) = state.harness().workspaces.as_ref() else {
        return respond::plugin_missing("workspace");
    };
    let Some(id) = body.non_empty("workspaceId") else {
        return respond::error(StatusCode::BAD_REQUEST, "a workspaceId is required");
    };
    let before = match body.get("beforeWorkspaceId") {
        None | Some(Value::Null) => None,
        Some(Value::String(before)) if !before.is_empty() => Some(before.as_str()),
        Some(_) => {
            return respond::error(
                StatusCode::BAD_REQUEST,
                "beforeWorkspaceId must be a workspace id",
            );
        }
    };
    match workspaces.insert_before(id, before) {
        Ok(order) => respond::json(StatusCode::OK, &json!({"workspaceIds": order})),
        Err(error) if error.code.as_deref() == Some("workspace/not-found") => {
            service_refusal(error, StatusCode::NOT_FOUND)
        }
        Err(error) => service_refusal(error, StatusCode::INTERNAL_SERVER_ERROR),
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
    // Only an .html or .htm file is a page (DSH's HTML renderer extensions); anything else, binary or
    // not, is refused, as web.ts does.
    if !preview::is_html_document(&path) {
        return respond::error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            preview::NOT_AN_HTML_DOCUMENT,
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
    // An installed package wins, so a checkout serves the version the TypeScript build serves; without one the binary
    // serves its own copy (live issue #39), so a Rust deployment does not depend on a Node install.
    let bytes = preview::purify_path(&state.options().asset_roots)
        .and_then(|path| std::fs::read(path).ok())
        .unwrap_or_else(|| preview::EMBEDDED_PURIFY.as_bytes().to_vec());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/javascript; charset=utf-8")
        .header("cache-control", "no-store")
        .body(Body::from(bytes))
        .expect("a response builder with static headers")
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

/// The body of the `409` a turn into a one-shot subagent's session gets, or `None` when the session takes turns —
/// web.ts `subagentTurnRefusal`.
///
/// DSH's generic session route leaves a subagent's child to subagent routing and refuses a prompt into it with
/// `session/agent-busy`, `session "<id>" is owned by subagent routing`, reason `use subagent delivery for this child
/// session` (dsh-api-session-controller `lib/index.js:128-142`, reached from `prompt` at `:925-926`). A one-shot child
/// has no delivery at all: `delegate` runs it for one task and settles it. Phase A measured both builds answering
/// `200` and growing the child's log (R-developer-eight-26). A teammate (`teamId`) is a continuable child, as DSH's
/// teammates are, and this route is the delivery the page uses for it, so it is not refused.
fn subagent_turn_refusal(meta: Option<&SessionMeta>) -> Option<Value> {
    let meta = meta?;
    if meta.rest.get("origin").and_then(Value::as_str) != Some("subagent") {
        return None;
    }
    if meta
        .rest
        .get("teamId")
        .and_then(Value::as_str)
        .is_some_and(|team| !team.is_empty())
    {
        return None;
    }
    Some(json!({
        "error": format!("session \"{}\" is owned by subagent routing", meta.id),
        "code": "session/agent-busy",
        "reason": "use subagent delivery for this child session",
    }))
}

async fn turn(State(state): State<AppState>, body: JsonBody) -> Response {
    // A prompt of only whitespace is no prompt (#32), as DSH's `hasPromptContent` refuses blank text.
    let Some(prompt) = body
        .str("prompt")
        .filter(|prompt| !prompt.trim().is_empty())
    else {
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

    // The agent preset the request names (inventory A96), checked before a session exists, as the endpoint is.
    let named_preset = match requested_preset(&state, &body) {
        Ok(named) => named,
        Err(refusal) => return respond::text(StatusCode::BAD_REQUEST, format!("{refusal}\n")),
    };
    let born_preset = new_session_preset(&state, named_preset.as_deref());
    let born = SessionSelection {
        endpoint: requested_endpoint.map(str::to_owned),
        model: requested_model.map(str::to_owned),
        reasoning_effort: requested_effort.map(str::to_owned),
    };
    let sessions = &state.harness().sessions;
    let resume = body.str("session").filter(|id| !id.is_empty());
    let folder = body.non_empty("folder").map(canonical_path);
    // A session this route opens is born untitled, as DSH's is (#68): its first message writes the fallback name and
    // the session layer's title coordinator asks the model for the title (heddle_session::title). A title given here
    // would read as a person's name, and no title would ever be generated.
    // A one-shot subagent's session takes no turn from here, refused before the session is opened so the child's log
    // gets nothing (web.ts asks `subagentTurnRefusal` at the same point).
    if let Some(resume) = resume {
        let resumed = sessions.meta(resume);
        if let Some(refusal) = subagent_turn_refusal(resumed.as_ref()) {
            return respond::json_compact(StatusCode::CONFLICT, &refusal);
        }
        // A session keeps the preset it was created with (DSH): another one named for it is refused before it is
        // opened.
        if let (Some(named), Some(recorded)) = (
            named_preset.as_deref(),
            resumed.as_ref().and_then(|meta| meta.preset()),
        ) && recorded != named
        {
            return preset_fixed(recorded);
        }
    }
    let session = if let Some(resume) = resume {
        // A resumed session keeps the selection it recorded; only a session this request creates is
        // born with the request's choice (web.ts passes `{ resume }` alone).
        sessions.start(StartSession {
            resume: Some(resume.to_owned()),
            cwd: None,
            title: None,
            selection: SessionSelection::default(),
            preset: None,
        })
    } else if let Some(folder) = folder.as_ref() {
        // web.ts opens the folder's session whether or not a workspace owns the folder, then adopts it
        // (`ctx.workspace?.ensureOwner(folder)`, below); the ownership refusal belongs to the new-session
        // route, not to a turn.
        sessions.open_at(
            folder,
            OpenAt {
                fresh: body.bool("new") == Some(true),
                title: None,
                selection: born.clone(),
                preset: born_preset.clone(),
            },
        )
    } else {
        sessions.start(StartSession {
            resume: None,
            cwd: Some(state.harness().cwd.clone()),
            title: None,
            selection: born.clone(),
            preset: born_preset.clone(),
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
    // The same rule for a folder's existing session, which is only known once it is opened: another preset named for
    // it is refused rather than silently ignored or applied. A session that recorded none takes the named one, but only
    // once the endpoint checks below have passed, so a refused turn records nothing.
    let recorded_preset = sessions
        .meta(&session)
        .and_then(|meta| meta.preset().map(str::to_owned));
    if let (Some(named), Some(recorded)) = (named_preset.as_deref(), recorded_preset.as_deref())
        && recorded != named
    {
        return preset_fixed(recorded);
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
    // The preset the request named, for a session that recorded none: now that nothing above refused the turn.
    if let Some(named) = named_preset.as_deref()
        && recorded_preset.is_none()
    {
        sessions.record_preset(&session, named);
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
                        &json!({"session": stream_session, "message": error.message}),
                    ));
                }
            }
        }
    });
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|frame| (frame, receiver))
    });
    sse_response(stream)
}

// ---------------------------------------------------------------------------------------------------------
// Terminals (#85)

/// Whether a write says it is JSON (`/^application\/json\s*(;|$)/i`, as web.ts judges it). A page sends JSON,
/// and a form on another site cannot.
fn json_write(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let lower = value.to_ascii_lowercase();
            lower.strip_prefix("application/json").is_some_and(|rest| {
                let rest = rest.trim_start();
                rest.is_empty() || rest.starts_with(';')
            })
        })
}

fn not_json_write() -> Response {
    respond::error(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "a terminal request must be sent as application/json",
    )
}

/// The checks every terminal route makes after the door, in web.ts's order:
/// - the session id's shape (`400`);
/// - the session is this server's (`404`) and its folder sits under one of its workspace roots (`403`);
/// - an archived session is refused (`409`).
///
/// `lenient` is for listing and closing, which stay open to an archived session and to one whose workspace was
/// removed, so its terminals can still be ended.
fn terminal_session(
    state: &AppState,
    raw: &str,
    lenient: bool,
) -> Result<(SessionId, SessionMeta), Box<Response>> {
    let id = SessionId::parse(raw).ok_or_else(|| Box::new(respond::not_a_session_id()))?;
    let meta = state
        .harness()
        .sessions
        .meta(id.as_str())
        .ok_or_else(|| Box::new(respond::no_session(id.as_str())))?;
    if let Some(workspaces) = &state.harness().workspaces
        && !lenient
        && !workspaces.owns(&canonical_path(meta.cwd.as_deref().unwrap_or("")))
    {
        return Err(Box::new(respond::error_with_code(
            StatusCode::FORBIDDEN,
            format!("session {id} is not under any workspace root of this server"),
            "not-owned",
        )));
    }
    if is_archived(&meta) && !lenient {
        return Err(Box::new(respond::error_with_code(
            StatusCode::CONFLICT,
            format!("session {id} is archived"),
            "archived",
        )));
    }
    Ok((id, meta))
}

fn is_archived(meta: &SessionMeta) -> bool {
    meta.rest.get("archived").and_then(Value::as_bool) == Some(true)
}

/// A write's JSON body, read after the checks as web.ts reads it: over `MAX_JSON_BODY` is `413 request too large`,
/// empty is `{}`, a non-object is `{}`, and anything else is `400 the body must be JSON`.
async fn terminal_body(body: Body) -> Result<Map<String, Value>, Box<Response>> {
    let Ok(bytes) = axum::body::to_bytes(body, respond::MAX_JSON_BODY).await else {
        return Err(Box::new(respond::text(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request too large\n",
        )));
    };
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(_) => Err(Box::new(respond::text(
            StatusCode::BAD_REQUEST,
            "the body must be JSON\n",
        ))),
    }
}

fn no_terminal(terminal: &str, session: &SessionId) -> Response {
    respond::error(
        StatusCode::NOT_FOUND,
        format!("no terminal {terminal} in session {session}"),
    )
}

fn terminal_size_refusal(state: &AppState) -> Response {
    let limits = state.terminals().limits();
    respond::error(
        StatusCode::BAD_REQUEST,
        format!(
            "cols and rows must be whole numbers from 1 to {} and {}",
            limits.max_cols, limits.max_rows
        ),
    )
}

async fn list_terminals(
    State(state): State<AppState>,
    axum::extract::Path(raw): axum::extract::Path<String>,
) -> Response {
    let (id, _) = match terminal_session(&state, &raw, true) {
        Ok(found) => found,
        Err(refusal) => return *refusal,
    };
    respond::json_compact(
        StatusCode::OK,
        &json!({
            "terminals": state.terminals().list(id.as_str()),
            "limits": state.terminals().limits(),
        }),
    )
}

async fn create_terminal(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(raw): axum::extract::Path<String>,
    body: Body,
) -> Response {
    if !json_write(&headers) {
        return not_json_write();
    }
    let (id, meta) = match terminal_session(&state, &raw, false) {
        Ok(found) => found,
        Err(refusal) => return *refusal,
    };
    let body = match terminal_body(body).await {
        Ok(body) => body,
        Err(refusal) => return *refusal,
    };
    let size = |key: &str, default: f64| match body.get(key) {
        None => Some(default),
        Some(value) => value.as_f64(),
    };
    let (Some(cols), Some(rows)) = (size("cols", 80.0), size("rows", 24.0)) else {
        return terminal_size_refusal(&state);
    };
    let limits = state.terminals().limits();
    if !limits.fits(cols, rows) {
        return terminal_size_refusal(&state);
    }
    let sandbox = state.harness().sandbox.clone();
    let mode = state
        .harness()
        .sessions
        .effective_mode(id.as_str(), &sandbox.default_mode());
    let root = sandbox.root_for(meta.cwd.as_deref().map(std::path::Path::new));
    if !root.is_dir() {
        return respond::error_with_code(
            StatusCode::CONFLICT,
            format!(
                "the session's folder {} is not an available directory",
                root.display()
            ),
            "cwd-missing",
        );
    }
    let spawn = TerminalSpawn {
        session: id.as_str().to_owned(),
        cwd: root.clone(),
        mode: mode.clone(),
        cols: cols as u32,
        rows: rows as u32,
        shell: None,
    };
    match state
        .terminals()
        .create(spawn, |argv| sandbox.confine(argv, &mode, &root))
    {
        Ok(info) => {
            // An archive that landed while this request was in flight found nothing to close, so the archive is
            // read again now that the terminal exists, and a terminal on an archived session is ended at once.
            let archived_now = state
                .harness()
                .sessions
                .meta(id.as_str())
                .is_some_and(|meta| is_archived(&meta));
            if archived_now {
                state.terminals().close(id.as_str(), &info.id).await;
                return respond::error_with_code(
                    StatusCode::CONFLICT,
                    format!("session {id} is archived"),
                    "archived",
                );
            }
            // The same race for the permission mode: a mode change that landed during the spawn closed only the
            // terminals already inserted, so this one would keep the old, possibly wider, confinement. It is ended
            // and refused rather than kept. TypeScript needs no twin: its create is synchronous after the mode read.
            let mode_now = state
                .harness()
                .sessions
                .effective_mode(id.as_str(), &sandbox.default_mode());
            if mode_now != mode {
                state.terminals().close(id.as_str(), &info.id).await;
                return respond::error_with_code(
                    StatusCode::CONFLICT,
                    format!(
                        "session {id}'s permission mode changed to {mode_now} while the terminal was starting; open it again"
                    ),
                    "mode-changed",
                );
            }
            respond::json_compact(StatusCode::CREATED, &json!({ "terminal": info }))
        }
        Err(CreateRefusal::Closed) => respond::error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "the server is shutting down",
            "shutting-down",
        ),
        Err(CreateRefusal::Limit) => respond::error_with_code(
            StatusCode::CONFLICT,
            format!(
                "session {id} already holds {} terminals; close one first",
                limits.max_terminals
            ),
            "limit",
        ),
        Err(CreateRefusal::Sandbox(message)) => respond::error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            message,
            "sandbox-unavailable",
        ),
        Err(CreateRefusal::Spawn(message)) => respond::internal_error(message),
    }
}

async fn close_terminal(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path((raw, terminal)): axum::extract::Path<(String, String)>,
) -> Response {
    if !json_write(&headers) {
        return not_json_write();
    }
    let (id, _) = match terminal_session(&state, &raw, true) {
        Ok(found) => found,
        Err(refusal) => return *refusal,
    };
    if !state.terminals().close(id.as_str(), &terminal).await {
        return no_terminal(&terminal, &id);
    }
    respond::json_compact(
        StatusCode::OK,
        &json!({ "closed": true, "terminal": terminal }),
    )
}

async fn input_terminal(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path((raw, terminal)): axum::extract::Path<(String, String)>,
    body: Body,
) -> Response {
    if !json_write(&headers) {
        return not_json_write();
    }
    let (id, _) = match terminal_session(&state, &raw, false) {
        Ok(found) => found,
        Err(refusal) => return *refusal,
    };
    let body = match terminal_body(body).await {
        Ok(body) => body,
        Err(refusal) => return *refusal,
    };
    let Some(data) = body.get("data").and_then(Value::as_str) else {
        return respond::error(StatusCode::BAD_REQUEST, "data must be a string");
    };
    match state.terminals().input(id.as_str(), &terminal, data).await {
        InputResult::Ok => respond::json_compact(StatusCode::OK, &json!({ "ok": true })),
        InputResult::Missing => no_terminal(&terminal, &id),
        InputResult::Exited => {
            respond::error_with_code(StatusCode::CONFLICT, "the terminal has exited", "exited")
        }
        InputResult::Busy => respond::error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "the terminal has too much input waiting; try again",
            "busy",
        ),
        InputResult::TooLarge => respond::error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "input is limited to {} bytes per request",
                state.terminals().limits().max_input_bytes
            ),
        ),
    }
}

async fn resize_terminal(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path((raw, terminal)): axum::extract::Path<(String, String)>,
    body: Body,
) -> Response {
    if !json_write(&headers) {
        return not_json_write();
    }
    let (id, _) = match terminal_session(&state, &raw, false) {
        Ok(found) => found,
        Err(refusal) => return *refusal,
    };
    let body = match terminal_body(body).await {
        Ok(body) => body,
        Err(refusal) => return *refusal,
    };
    let (Some(cols), Some(rows)) = (
        body.get("cols").and_then(Value::as_f64),
        body.get("rows").and_then(Value::as_f64),
    ) else {
        return respond::error(
            StatusCode::BAD_REQUEST,
            "cols and rows are required numbers",
        );
    };
    match state
        .terminals()
        .resize(id.as_str(), &terminal, cols, rows)
        .await
    {
        ResizeResult::Ok => respond::json_compact(
            StatusCode::OK,
            &json!({ "ok": true, "cols": cols as u32, "rows": rows as u32 }),
        ),
        ResizeResult::Missing => no_terminal(&terminal, &id),
        ResizeResult::Exited => {
            respond::error_with_code(StatusCode::CONFLICT, "the terminal has exited", "exited")
        }
        ResizeResult::OutOfRange => terminal_size_refusal(&state),
        ResizeResult::Unavailable => respond::error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "the terminal could not be resized",
            "unavailable",
        ),
    }
}

/// One frame of a terminal stream, as web.ts writes it: `event: <type>` and the event's JSON.
fn terminal_frame(event: &TerminalEvent) -> String {
    let name = match event {
        TerminalEvent::Output { .. } => "output",
        TerminalEvent::Exit { .. } => "exit",
    };
    format!(
        "event: {name}\ndata: {}\n\n",
        serde_json::to_string(event).expect("a terminal event serializes")
    )
}

/// One terminal's output as an event stream: a `snapshot` of the retained tail first, then `output` frames and
/// one `exit`, after which the stream ends. The listener is attached before the snapshot is taken, so no output
/// falls between them. A heartbeat comment keeps an idle stream open; dropping the body detaches.
async fn stream_terminal(
    State(state): State<AppState>,
    axum::extract::Path((raw, terminal)): axum::extract::Path<(String, String)>,
) -> Response {
    use futures::StreamExt;

    let (id, _) = match terminal_session(&state, &raw, false) {
        Ok(found) => found,
        Err(refusal) => return *refusal,
    };
    let Some((snapshot, receiver, hold)) = state.terminals().attach(id.as_str(), &terminal) else {
        return no_terminal(&terminal, &id);
    };
    let opening = format!(
        "{}event: snapshot\ndata: {}\n\n",
        stream::STREAM_OPEN,
        serde_json::to_string(&snapshot).expect("a snapshot serializes")
    );
    let ended = snapshot.exited;
    let closing = ended.then(|| {
        terminal_frame(&TerminalEvent::Exit {
            code: snapshot.exit_code,
        })
    });
    let mut ticker = tokio::time::interval(stream::heartbeat_interval());
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let live = futures::stream::unfold(
        (receiver, hold, ticker, ended, false),
        |(mut receiver, hold, mut ticker, ended, primed)| async move {
            if ended {
                return None;
            }
            let mut primed = primed;
            if !primed {
                // The first tick of an interval completes at once; it is spent here, not sent.
                ticker.tick().await;
                primed = true;
            }
            tokio::select! {
                event = receiver.recv() => match event {
                    Some(event) => {
                        let last = matches!(event, TerminalEvent::Exit { .. });
                        Some((terminal_frame(&event), (receiver, hold, ticker, last, primed)))
                    }
                    None => None,
                },
                _ = ticker.tick() => Some((": heartbeat\n\n".to_owned(), (receiver, hold, ticker, false, primed))),
            }
        },
    );
    let body = futures::stream::once(async move { opening })
        .chain(futures::stream::iter(closing))
        .chain(live)
        .map(Ok::<_, std::io::Error>);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store")
        .header("connection", "keep-alive")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(body))
        .expect("a response builder with static headers")
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
        /// Answers for successive `effective_mode` reads, first to last; the fallback once it is empty.
        modes: std::sync::Mutex<Vec<String>>,
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
                modes: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl SessionService for Sessions {
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
            _preset: Option<&str>,
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
            let mut modes = self.modes.lock().unwrap();
            if modes.is_empty() {
                fallback.to_owned()
            } else {
                modes.remove(0)
            }
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

    fn temp_secret(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("heddle-server-test-{label}-{}", std::process::id()))
            .join("web-secret")
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

    /// A registry double for the reorder route: an order of three ids, moved as DSH's `insertBefore` does,
    /// recording what the route handed it.
    #[derive(Default)]
    struct OrderWorkspaces {
        asked: std::sync::Mutex<Vec<(String, Option<String>)>>,
    }

    impl crate::services::WorkspaceService for OrderWorkspaces {
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
        fn insert_before(
            &self,
            id: &str,
            before: Option<&str>,
        ) -> Result<Vec<String>, ServiceError> {
            self.asked
                .lock()
                .unwrap()
                .push((id.to_owned(), before.map(str::to_owned)));
            let order = ["w-1", "w-2", "w-3"];
            for key in std::iter::once(id).chain(before) {
                if !order.contains(&key) {
                    return Err(crate::services::workspace_not_found(key));
                }
            }
            let mut moved: Vec<String> = order
                .iter()
                .filter(|each| **each != id)
                .map(|each| (*each).to_owned())
                .collect();
            let at = before
                .and_then(|anchor| moved.iter().position(|each| each == anchor))
                .unwrap_or(moved.len());
            moved.insert(at, id.to_owned());
            Ok(moved)
        }
    }

    #[tokio::test]
    async fn the_reorder_route_answers_the_complete_order_and_dshs_not_found() {
        // Without the plugin: the same refusal every workspace route gives.
        let (router, _) = app("workspaces-order-missing");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _) = post_json(
            &router,
            "/api/workspaces/insertBefore",
            &cookie,
            r#"{"workspaceId":"w-1"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

        let registry = Arc::new(OrderWorkspaces::default());
        let mut with_registry = harness();
        with_registry.workspaces = Some(registry.clone());
        let (router, _) = ServerBuilder::new(
            with_registry,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("workspaces-order")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let post = |body: &'static str| {
            let router = router.clone();
            let cookie = cookie.clone();
            async move {
                let (status, bytes) =
                    post_json(&router, "/api/workspaces/insertBefore", &cookie, body).await;
                (status, String::from_utf8(bytes).unwrap())
            }
        };

        // Before an anchor: `{workspaceIds}`, the complete order, as web.ts writes it.
        let (status, text) = post(r#"{"workspaceId":"w-3","beforeWorkspaceId":"w-1"}"#).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert_eq!(
            text,
            "{\n  \"workspaceIds\": [\n    \"w-3\",\n    \"w-1\",\n    \"w-2\"\n  ]\n}\n"
        );
        // No anchor, or a null one, appends.
        let (_, text) = post(r#"{"workspaceId":"w-1"}"#).await;
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["workspaceIds"],
            json!(["w-2", "w-3", "w-1"])
        );
        let (status, _) = post(r#"{"workspaceId":"w-1","beforeWorkspaceId":null}"#).await;
        assert_eq!(status, StatusCode::OK);

        // An unknown workspace or anchor: 404 with DSH's code and sentence, naming the one missing.
        let (status, text) = post(r#"{"workspaceId":"w-9","beforeWorkspaceId":"w-1"}"#).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            text,
            "{\"error\":\"Workspace \\\"w-9\\\" not found\",\"code\":\"workspace/not-found\"}\n"
        );
        let (status, text) = post(r#"{"workspaceId":"w-1","beforeWorkspaceId":"w-8"}"#).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(text.contains(r#"Workspace \"w-8\" not found"#), "{text}");

        // A request without a workspace, or with an anchor that is not an id, is refused before the
        // registry is asked.
        let asked = registry.asked.lock().unwrap().len();
        for body in [
            r#"{}"#,
            r#"{"workspaceId":""}"#,
            r#"{"workspaceId":3}"#,
            r#"{"workspaceId":"w-1","beforeWorkspaceId":7}"#,
            r#"{"workspaceId":"w-1","beforeWorkspaceId":""}"#,
        ] {
            let (status, text) = post(body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {text}");
        }
        assert_eq!(registry.asked.lock().unwrap().len(), asked);
        assert_eq!(
            registry.asked.lock().unwrap()[0],
            ("w-3".to_owned(), Some("w-1".to_owned()))
        );
    }

    /// A registry with one root: it owns what is at or under that folder, and records every tree it
    /// is asked for, so a test can tell a refusal from a listing that was read and then dropped.
    struct OneRoot {
        root: PathBuf,
        asked: std::sync::Mutex<Vec<Option<PathBuf>>>,
    }

    impl crate::services::WorkspaceService for OneRoot {
        fn owns(&self, path: &std::path::Path) -> bool {
            path.starts_with(&self.root)
        }
        fn tree(
            &self,
            path: Option<&std::path::Path>,
            _archived: crate::services::ArchivedFilter,
            _sessions: &[SessionMeta],
        ) -> Result<Value, ServiceError> {
            self.asked.lock().unwrap().push(path.map(Path::to_path_buf));
            Ok(json!({"children": ["listed"]}))
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
        fn views(&self, _sessions: &[SessionMeta]) -> Result<Value, ServiceError> {
            Ok(json!([]))
        }
    }

    /// Percent-encode a path for a query string, every byte outside the unreserved set.
    fn query_value(path: &Path) -> String {
        path.to_string_lossy()
            .bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (byte as char).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn the_tree_route_refuses_a_path_outside_every_root_as_web_ts_does() {
        let base = std::env::temp_dir().join(format!("heddle-tree-owner-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("root").join("inner")).unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        std::fs::write(base.join("elsewhere").join("not-yours.txt"), "x\n").unwrap();
        std::os::unix::fs::symlink(base.join("elsewhere"), base.join("root").join("way-out"))
            .unwrap();
        let base = std::fs::canonicalize(&base).unwrap();
        let root = base.join("root");
        let elsewhere = base.join("elsewhere");
        let registry = Arc::new(OneRoot {
            root: root.clone(),
            asked: std::sync::Mutex::new(Vec::new()),
        });
        let mut with_root = harness();
        with_root.workspaces = Some(registry.clone());
        let (router, _) = ServerBuilder::new(
            with_root,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("tree-owner")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let tree = |path: &Path| format!("/api/tree?path={}", query_value(path));
        let refusal = format!(
            "{{\"error\":\"{} is not under any workspace root\"}}\n",
            elsewhere.display()
        );

        // A folder outside every root, a symlink in the root that leads to it, and a `..` walk out
        // of the root: each is web.ts's 400 naming the canonical path, and nothing is listed.
        for (what, uri) in [
            ("a folder outside every root", tree(&elsewhere)),
            ("a symlink that leads out", tree(&root.join("way-out"))),
            ("a dot-dot walk", tree(&root.join("..").join("elsewhere"))),
        ] {
            let (status, headers, bytes) = call(&router, Method::GET, &uri, Some(&cookie)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{what} is refused");
            assert_eq!(headers["content-type"], "application/json");
            assert_eq!(body_text(&bytes), refusal, "{what} gets web.ts's answer");
        }
        assert!(
            registry.asked.lock().unwrap().is_empty(),
            "a refused path is never handed to the tree: {:?}",
            registry.asked.lock().unwrap()
        );

        // Inside the root it lists, and no path (or an empty one, as web.ts reads it) is the roots.
        for (uri, expected) in [
            (tree(&root.join("inner")), Some(root.join("inner"))),
            (tree(&root), Some(root.clone())),
            ("/api/tree".to_owned(), None),
            ("/api/tree?path=".to_owned(), None),
        ] {
            let (status, _, bytes) = call(&router, Method::GET, &uri, Some(&cookie)).await;
            assert_eq!(status, StatusCode::OK, "{uri}: {}", body_text(&bytes));
            assert_eq!(
                registry.asked.lock().unwrap().pop(),
                Some(expected),
                "{uri}"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn the_html_route_previews_only_an_html_document() {
        let dir = std::env::temp_dir().join(format!("heddle-html-only-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("page.html"), "<h1>page</h1>").unwrap();
        // A real Word document is a zip; a text file is valid UTF-8. Neither is a page.
        std::fs::write(
            dir.join("report.docx"),
            b"PK\x03\x04\x14\x00\x00\x00\x08\x00binary",
        )
        .unwrap();
        std::fs::write(dir.join("notes.txt"), "plain words").unwrap();
        let mut with_registry = harness();
        with_registry.workspaces = Some(Arc::new(ViewWorkspaces));
        let (router, _) = ServerBuilder::new(
            with_registry,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("html-only")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let uri = |leaf: &str| {
            format!(
                "/api/html?path={}",
                dir.join(leaf).to_string_lossy().replace('/', "%2F")
            )
        };
        let (status, _, bytes) = call(&router, Method::GET, &uri("page.html"), Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
        assert!(body_text(&bytes).contains("page"), "{}", body_text(&bytes));
        for leaf in ["report.docx", "notes.txt"] {
            let (status, _, bytes) = call(&router, Method::GET, &uri(leaf), Some(&cookie)).await;
            assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{leaf}");
            assert_eq!(
                body_text(&bytes),
                format!("{{\"error\":\"{}\"}}\n", preview::NOT_AN_HTML_DOCUMENT),
                "{leaf}"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_terminal_whose_mode_changed_while_it_started_is_ended_and_refused() {
        // #85 R1: create reads the mode, spawns (milliseconds of fork/exec), then inserts. A permission change in
        // that window closes only inserted terminals, so create reads the mode again and refuses a mismatch. The
        // first read answers the mode the spawn uses; the second, the mode a concurrent change wrote.
        let folder = std::env::temp_dir().join(format!("heddle-r1-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let id = "session-00000000-0000-0000-0000-000000000001";
        let sessions = Sessions {
            metas: vec![SessionMeta {
                id: id.into(),
                cwd: Some(folder.to_string_lossy().into_owned()),
                turns: 1,
                ..SessionMeta::default()
            }],
            events: HashMap::new(),
            modes: std::sync::Mutex::new(vec!["danger-full-access".into(), "read-only".into()]),
        };
        let harness = Harness::new(
            Arc::new(sessions),
            Arc::new(Models),
            Arc::new(Turns),
            Arc::new(Sandbox),
            PathBuf::from("/work"),
        );
        let (router, state) = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("terminal-mode-changed")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, bytes) = post_json(
            &router,
            &format!("/api/sessions/{id}/terminals"),
            &cookie,
            "{}",
        )
        .await;
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        assert_eq!(status, StatusCode::CONFLICT, "{}", body_text(&bytes));
        assert_eq!(body["code"], "mode-changed", "{body}");
        assert!(
            state.terminals().list(id).is_empty(),
            "the terminal that started under the old mode is gone"
        );
        let _ = std::fs::remove_dir_all(&folder);
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
        // A prompt of only whitespace is refused before anything else, as an empty one is (#32).
        for blank in [
            r#"{"prompt":""}"#,
            r#"{"prompt":"   "}"#,
            r#"{"prompt":"\n\t "}"#,
        ] {
            let (status, bytes) = post_json(&router, "/api/turn", &cookie, blank).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{blank}");
            assert_eq!(body_text(&bytes), "a prompt is required\n", "{blank}");
        }
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

    /// The agent runtime's live-turn registry, as a double: one turn this server did not start.
    #[derive(Default)]
    struct OneRowTurn {
        interrupted: std::sync::Mutex<Vec<String>>,
    }

    impl crate::services::TurnInterrupter for OneRowTurn {
        fn interrupt(&self, session: &str) -> bool {
            let mut seen = self.interrupted.lock().unwrap();
            seen.push(session.to_owned());
            seen.len() == 1
        }
    }

    #[tokio::test]
    async fn stop_reaches_a_turn_a_row_started_such_as_a_goal_round() {
        let rows = Arc::new(OneRowTurn::default());
        let mut with_rows = harness();
        with_rows.interrupter = Some(rows.clone());
        let (router, _) = ServerBuilder::new(
            with_rows,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("stop-rows")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let stop = "/api/sessions/session-00000000-0000-0000-0000-000000000001/stop";
        let (status, bytes) = post_json(&router, stop, &cookie, "{}").await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["stopped"], 1,
            "the goal round was stopped, though the server never started it"
        );
        let (_, bytes) = post_json(&router, stop, &cookie, "{}").await;
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["stopped"], 0, "nothing left to stop");
        assert_eq!(rows.interrupted.lock().unwrap().len(), 2);
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

    /// A runner that writes what the agent loop writes first into a real store: the prompt as the user message.
    struct RecordingTurns(heddle_session::SessionService);

    impl TurnRunner for RecordingTurns {
        fn run_turn(
            &self,
            request: TurnRequest,
        ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
            let service = self.0.clone();
            Box::pin(async move {
                let handle = service
                    .open(&request.session)
                    .expect("the session the route opened");
                service
                    .user(&handle, &request.prompt, None)
                    .expect("the user message");
                Ok(TurnOutcome::default())
            })
        }
    }

    #[tokio::test]
    async fn a_session_the_turn_route_opens_is_born_untitled_so_its_first_prompt_names_it() {
        // #68: DSH writes no title when a session is created. dsh-session-title writes the fallback from the first
        // eligible human message (lib/index.js:396-403, 620-648) and asks the first-prompt provider only for a session
        // with no title yet (:387). The turn route opened its session titled with the prompt's first sixty characters,
        // so the first message wrote no fallback and the title coordinator asked nothing (heddle_session::title).
        use crate::adapters::StoreSessions;
        const PROMPT: &str = "Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.";
        let scratch = std::env::temp_dir().join(format!(
            "heddle-server-turn-route-title-{}-{}",
            std::process::id(),
            token::now_ms()
        ));
        std::fs::create_dir_all(scratch.join("ws")).unwrap();
        let scratch = std::fs::canonicalize(&scratch).unwrap();
        let inner = heddle_session::SessionService::new(
            &heddle_session::SessionConfig {
                root: Some(scratch.join("sessions").to_string_lossy().into_owned()),
            },
            &heddle_config::Env::default(),
            None,
        );
        let harness = Harness::new(
            Arc::new(StoreSessions::new(inner.clone())),
            Arc::new(Models),
            Arc::new(RecordingTurns(inner.clone())),
            Arc::new(Sandbox),
            scratch.clone(),
        );
        let (router, _) = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("turn-route-title")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let fallback = heddle_session::title_from(PROMPT);
        let cut: String = PROMPT.chars().take(60).collect();
        for body in [
            json!({"prompt": PROMPT, "folder": scratch.join("ws"), "new": true}),
            json!({"prompt": PROMPT}),
        ] {
            let before: Vec<String> = inner
                .list()
                .iter()
                .map(|meta| meta.id().to_owned())
                .collect();
            let (status, bytes) = post_json(&router, "/api/turn", &cookie, &body.to_string()).await;
            assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
            let made: Vec<Option<String>> = inner
                .list()
                .iter()
                .filter(|meta| !before.iter().any(|id| id == meta.id()))
                .map(|meta| meta.title().map(str::to_owned))
                .collect();
            assert_eq!(made.len(), 1, "{body}: the turn opened one new session");
            assert_eq!(
                made[0].as_deref(),
                Some(fallback.as_str()),
                "{body}: the first message wrote the fallback, cut at a word, which a generated title may replace"
            );
            assert_ne!(made[0].as_deref(), Some(cut.as_str()), "{body}");
        }
        std::fs::remove_dir_all(&scratch).ok();
    }

    /// A runner that counts the turns it is asked to run.
    struct CountingTurns(Arc<std::sync::atomic::AtomicUsize>);

    impl TurnRunner for CountingTurns {
        fn run_turn(
            &self,
            _request: TurnRequest,
        ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Ok(TurnOutcome::default()) })
        }
    }

    #[tokio::test]
    async fn a_turn_into_a_one_shot_subagent_session_is_refused_in_dshs_words() {
        // DSH parity C23 (R-developer-eight-26): dsh-api-session-controller refuses a prompt into a subagent's child
        // with `session/agent-busy` (`lib/index.js:128-142`); phase A measured `/api/turn` answering 200 and running it.
        // A teammate is a continuable child and still takes the turn.
        let child = "session-one-shot-child";
        let mate = "session-continuable-teammate";
        let meta = |id: &str, rest: Value| SessionMeta {
            id: id.into(),
            cwd: Some("/work".into()),
            endpoint: Some("double".into()),
            turns: 1,
            rest: rest.as_object().cloned().unwrap_or_default(),
            ..SessionMeta::default()
        };
        let sessions = Sessions {
            metas: vec![
                meta(
                    child,
                    json!({"parentSession": "session-p", "origin": "subagent", "delegationDepth": 1}),
                ),
                meta(
                    mate,
                    json!({"parentSession": "session-l", "origin": "subagent", "delegationDepth": 1, "teamId": "session-l"}),
                ),
            ],
            events: HashMap::new(),
            modes: std::sync::Mutex::new(Vec::new()),
        };
        let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut harness = Harness::new(
            Arc::new(sessions),
            Arc::new(Models),
            Arc::new(CountingTurns(Arc::clone(&ran))),
            Arc::new(Sandbox),
            PathBuf::from("/work"),
        );
        harness.approvals = Some(Arc::new(Approvals));
        let (router, _) = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret("subagent-turn-refusal")),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();

        let into_child = json!({"session": child, "prompt": "write into child"});
        let (status, bytes) =
            post_json(&router, "/api/turn", &cookie, &into_child.to_string()).await;
        assert_eq!(status, StatusCode::CONFLICT, "{}", body_text(&bytes));
        assert_eq!(
            body_text(&bytes),
            format!(
                "{{\"error\":\"session \\\"{child}\\\" is owned by subagent routing\",\"code\":\"session/agent-busy\",\"reason\":\"use subagent delivery for this child session\"}}\n"
            )
        );
        assert_eq!(
            ran.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no turn ran in the child"
        );

        let into_mate = json!({"session": mate, "prompt": "a message for the teammate"});
        let (status, bytes) =
            post_json(&router, "/api/turn", &cookie, &into_mate.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
        assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1);

        assert_eq!(subagent_turn_refusal(None), None);
        assert_eq!(
            subagent_turn_refusal(Some(&meta("session-plain", json!({})))),
            None
        );
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
    async fn the_sanitiser_is_javascript_whether_installed_or_not() {
        // Not installed: the binary's own copy (live issue #39: this answered 404, and every HTML preview showed its
        // source on a deployment without node_modules).
        let (router, _) = app("purify-missing");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, headers, bytes) =
            call(&router, Method::GET, "/vendor/purify.js", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "text/javascript; charset=utf-8");
        assert!(
            body_text(&bytes).starts_with("/*! @license DOMPurify "),
            "the sanitiser itself, not a refusal"
        );

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
        let data: Value =
            serde_json::from_str(rest.lines().nth(1).unwrap().trim_start_matches("data: "))
                .unwrap();
        assert_eq!(data["type"], "ready");
        let client = data["clientId"].as_str().unwrap();
        assert!(
            client.len() == 32 && client.chars().all(|c| c.is_ascii_hexdigit()),
            "{client}"
        );
        assert_eq!(
            data["host"]["home"],
            std::env::var("HOME").unwrap_or_default()
        );
        assert!(
            rest.find("event: ready").unwrap() < rest.find("event: session").unwrap(),
            "{text}"
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

    /// Content search over the real store (R-developer-eight-19): a phrase in an answer finds its session, in
    /// DSH's order (more phrase marks first), with its snippet; a token fragment is no match; a refused query
    /// answers DSH's sentence; and a session id is still a session.
    #[tokio::test]
    async fn content_search_finds_a_phrase_inside_an_answer() {
        use crate::adapters::StoreSessions;
        use crate::services::SessionService as _;

        let scratch = std::env::temp_dir().join(format!(
            "heddle-server-content-search-{}-{}",
            std::process::id(),
            token::now_ms()
        ));
        std::fs::create_dir_all(&scratch).unwrap();
        let scratch = std::fs::canonicalize(&scratch).unwrap();
        let sessions = StoreSessions::new(heddle_session::SessionService::new(
            &heddle_session::SessionConfig {
                root: Some(scratch.join("sessions").to_string_lossy().into_owned()),
            },
            &heddle_config::Env::default(),
            None,
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
                secret_path: Some(temp_secret("content-search")),
                ..ServerOptions::default()
            },
        );
        let (router, _) = builder.into_router(3082).expect("the test router");

        let answered = |folder: &str, text: &str| -> String {
            let cwd = scratch.join(folder);
            std::fs::create_dir_all(&cwd).unwrap();
            let id = sessions
                .start(StartSession {
                    cwd: Some(cwd),
                    ..StartSession::default()
                })
                .unwrap();
            let store = sessions.inner().store();
            let handle = store.open(&id).unwrap();
            store
                .message(
                    &handle,
                    heddle_session::Message {
                        role: heddle_session::Role::Assistant,
                        tool_call_id: None,
                        content: vec![heddle_session::ContentPart::Text {
                            text: text.to_string(),
                        }],
                        source: None,
                    },
                )
                .unwrap();
            id
        };
        let one = answered("one", "The quokka ledger is balanced.");
        let two = answered("two", "A quokka ledger here, another QUOKKA LEDGER there.");
        answered("three", "quokkaledger, or the quokka and its ledger.");

        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        let (status, _, bytes) = call(
            &router,
            Method::GET,
            "/api/sessions/search?q=Quokka%20Ledger",
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            page,
            json!({
                "items": [
                    {"sessionId": two, "snippet": "A quokka ledger here, another QUOKKA LEDGER there."},
                    {"sessionId": one, "snippet": "The quokka ledger is balanced."},
                ],
                "hasMore": false,
            })
        );

        let (status, _, bytes) = call(
            &router,
            Method::GET,
            "/api/sessions/search?q=quokkaled",
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page, json!({"items": [], "hasMore": false}));

        for path in ["/api/sessions/search", "/api/sessions/search?q=%20%20"] {
            let (status, _, bytes) = call(&router, Method::GET, path, Some(&cookie)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
            let refusal: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(refusal["error"], "session search query must not be empty");
        }
        let (status, _, _) = call(
            &router,
            Method::GET,
            &format!("/api/sessions/{one}"),
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "a session id is still a session");
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

    // ---- Agent presets (inventory A96): web.ts's GET /api/presets and the preset a request creates a session under,
    // over the real session store. ----

    /// The test's `presets` row: `standard` (every tool, the default) and `reader` (one tool and a persona).
    fn preset_roster() -> Arc<heddle_config::PresetRoster> {
        Arc::new(
            heddle_config::preset_roster(Some(&json!({
                "default": "standard",
                "presets": [
                    { "id": "standard", "name": "Standard" },
                    { "id": "reader", "name": "Reader", "tools": ["read_file"], "persona": "You review." }
                ]
            })))
            .unwrap(),
        )
    }

    /// A router over a real store in a scratch folder, every folder owned, with `presets` as the profile's roster.
    async fn preset_app(
        label: &str,
        presets: Option<Arc<heddle_config::PresetRoster>>,
    ) -> (Router, crate::adapters::StoreSessions, PathBuf, String) {
        let scratch = std::env::temp_dir().join(format!(
            "heddle-server-presets-{label}-{}-{}",
            std::process::id(),
            token::now_ms()
        ));
        std::fs::create_dir_all(&scratch).unwrap();
        let scratch = std::fs::canonicalize(&scratch).unwrap();
        let sessions = crate::adapters::StoreSessions::new(heddle_session::SessionService::new(
            &heddle_session::SessionConfig {
                root: Some(scratch.join("sessions").to_string_lossy().into_owned()),
            },
            &heddle_config::Env::default(),
            None,
        ));
        let mut harness = Harness::new(
            Arc::new(sessions.clone()),
            Arc::new(Models),
            Arc::new(Turns),
            Arc::new(Sandbox),
            scratch.clone(),
        );
        harness.workspaces = Some(Arc::new(ViewWorkspaces));
        harness.presets = presets;
        let (router, _) = ServerBuilder::new(
            harness,
            ServerOptions {
                token: Some("test-token".into()),
                secret_path: Some(temp_secret(&format!("presets-{label}"))),
                ..ServerOptions::default()
            },
        )
        .into_router(3082)
        .expect("the test router");
        let (_, headers, _) = call(&router, Method::GET, "/?token=test-token", None).await;
        let cookie = headers["set-cookie"].split(';').next().unwrap().to_owned();
        (router, sessions, scratch, cookie)
    }

    fn preset_of(sessions: &crate::adapters::StoreSessions, id: &str) -> Option<String> {
        use crate::services::SessionService as _;
        sessions
            .meta(id)
            .and_then(|meta| meta.preset().map(str::to_owned))
    }

    #[tokio::test]
    async fn the_presets_route_answers_the_roster_and_marks_the_implicit_one() {
        let (router, _, scratch, cookie) = preset_app("route-implicit", None).await;
        let (status, headers, bytes) =
            call(&router, Method::GET, "/api/presets", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["content-type"], "application/json");
        let implicit: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            implicit,
            json!({
                "default": "standard",
                "presets": [serde_json::to_value(heddle_config::standard_preset()).unwrap()],
                "implicit": true
            })
        );
        std::fs::remove_dir_all(&scratch).ok();

        let (router, _, scratch, cookie) =
            preset_app("route-declared", Some(preset_roster())).await;
        let (status, _, bytes) = call(&router, Method::GET, "/api/presets", Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK);
        let declared: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(declared["default"], "standard");
        assert_eq!(
            declared.get("implicit"),
            None,
            "a declared roster is not marked"
        );
        assert_eq!(declared["presets"][1]["id"], "reader");
        assert_eq!(declared["presets"][1]["tools"], json!(["read_file"]));
        assert_eq!(
            declared["presets"][0].get("tools"),
            None,
            "absent means every tool"
        );
        std::fs::remove_dir_all(&scratch).ok();
    }

    #[tokio::test]
    async fn a_turn_creates_its_session_under_the_named_preset_or_the_default_and_refuses_an_undeclared_one()
     {
        use crate::services::SessionService as _;
        let (router, sessions, scratch, cookie) = preset_app("turn", Some(preset_roster())).await;

        // An undeclared preset is refused before anything is written, in DSH's words, as plain text.
        let (status, bytes) = post_json(
            &router,
            "/api/turn",
            &cookie,
            r#"{"prompt":"hello","preset":"nope"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(&bytes),
            "Unknown agent preset: nope; declared: standard, reader\n"
        );
        assert!(
            sessions.list().is_empty(),
            "the refused request wrote nothing"
        );

        // A new session runs under the preset the request names, and the session view says so.
        let (status, bytes) = post_json(
            &router,
            "/api/turn",
            &cookie,
            r#"{"prompt":"read it","preset":" reader "}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
        let reader = sessions.list()[0].id.clone();
        assert_eq!(preset_of(&sessions, &reader).as_deref(), Some("reader"));
        let (_, _, bytes) = call(
            &router,
            Method::GET,
            &format!("/api/sessions/{reader}"),
            Some(&cookie),
        )
        .await;
        let view: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(view["preset"], "reader");

        // The session keeps it: another preset named for it is refused, the same one is fine.
        let other = json!({"prompt": "again", "session": reader, "preset": "standard"});
        let (status, bytes) = post_json(&router, "/api/turn", &cookie, &other.to_string()).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body_text(&bytes),
            "{\"error\":\"the session runs the preset 'reader'; a session keeps the preset it was created with\",\"code\":\"session/preset-fixed\"}\n"
        );
        let same = json!({"prompt": "again", "session": reader, "preset": "reader"});
        let (status, _) = post_json(&router, "/api/turn", &cookie, &same.to_string()).await;
        assert_eq!(status, StatusCode::OK);

        // A request that names none creates its session under the default.
        let before: Vec<String> = sessions.list().into_iter().map(|meta| meta.id).collect();
        let (status, _) = post_json(&router, "/api/turn", &cookie, r#"{"prompt":"plain"}"#).await;
        assert_eq!(status, StatusCode::OK);
        let plain = sessions
            .list()
            .into_iter()
            .map(|meta| meta.id)
            .find(|id| !before.contains(id))
            .expect("a new session");
        assert_eq!(preset_of(&sessions, &plain).as_deref(), Some("standard"));

        // A session that recorded none takes the one a request names.
        let older = sessions
            .start(StartSession {
                cwd: Some(scratch.clone()),
                ..StartSession::default()
            })
            .unwrap();
        assert_eq!(preset_of(&sessions, &older), None);
        let (_, _, bytes) = call(
            &router,
            Method::GET,
            &format!("/api/sessions/{older}"),
            Some(&cookie),
        )
        .await;
        let view: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(view["preset"], Value::Null);
        let named = json!({"prompt": "now", "session": older, "preset": "reader"});
        let (status, _) = post_json(&router, "/api/turn", &cookie, &named.to_string()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(preset_of(&sessions, &older).as_deref(), Some("reader"));
        std::fs::remove_dir_all(&scratch).ok();
    }

    #[tokio::test]
    async fn without_the_presets_row_a_turn_names_only_the_implicit_preset_and_creates_none() {
        use crate::services::SessionService as _;
        let (router, sessions, scratch, cookie) = preset_app("turn-implicit", None).await;
        let (status, bytes) = post_json(
            &router,
            "/api/turn",
            &cookie,
            r#"{"prompt":"hello","preset":"reader"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(&bytes),
            "Unknown agent preset: reader; declared: standard\n"
        );
        let (status, _) = post_json(&router, "/api/turn", &cookie, r#"{"prompt":"plain"}"#).await;
        assert_eq!(status, StatusCode::OK);
        let plain = sessions.list()[0].id.clone();
        assert_eq!(preset_of(&sessions, &plain), None, "no roster, no preset");
        std::fs::remove_dir_all(&scratch).ok();
    }

    #[tokio::test]
    async fn a_new_session_route_creates_under_the_named_preset_and_refuses_an_undeclared_one() {
        use crate::services::SessionService as _;
        let (router, sessions, scratch, cookie) =
            preset_app("sessions", Some(preset_roster())).await;
        let branch = scratch.join("branch");
        std::fs::create_dir_all(&branch).unwrap();

        let refused = json!({"branch": branch, "preset": "nope"});
        let (status, bytes) =
            post_json(&router, "/api/sessions", &cookie, &refused.to_string()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(&bytes),
            "{\"error\":\"Unknown agent preset: nope; declared: standard, reader\"}\n"
        );
        assert!(
            sessions.list().is_empty(),
            "the refused request wrote nothing"
        );

        let named = json!({"branch": branch, "preset": "reader", "title": "reading"});
        let (status, bytes) =
            post_json(&router, "/api/sessions", &cookie, &named.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
        let created: Value = serde_json::from_slice(&bytes).unwrap();
        let id = created["session"].as_str().unwrap().to_owned();
        assert_eq!(preset_of(&sessions, &id).as_deref(), Some("reader"));

        let plain = json!({"branch": branch});
        let (status, bytes) =
            post_json(&router, "/api/sessions", &cookie, &plain.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{}", body_text(&bytes));
        let created: Value = serde_json::from_slice(&bytes).unwrap();
        let id = created["session"].as_str().unwrap().to_owned();
        assert_eq!(preset_of(&sessions, &id).as_deref(), Some("standard"));
        std::fs::remove_dir_all(&scratch).ok();
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
