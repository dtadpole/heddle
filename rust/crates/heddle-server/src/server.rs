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
//! A feature crate depends on this one, implements [`Feature`], and the binary mounts it:
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

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::response::Response;
use serde::Serialize;
use serde_json::Value;

use crate::respond::SessionId;
use crate::runs::RunRegistry;
use crate::services::Harness;
use crate::stream::EventHub;

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
        todo!()
    }

    /// The port the server asks for (`0` is "any").
    pub fn port(&self) -> u16 {
        todo!()
    }
}

/// The launch URL: `http://<host>:<port>/?token=<token>`.
pub fn launch_url(host: &str, port: u16, token: &str) -> String {
    todo!()
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
        todo!()
    }

    /// `heddle web: would serve <url>`.
    pub fn announce(&self) -> String {
        todo!()
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
        todo!()
    }

    pub fn events(&self) -> &EventHub {
        todo!()
    }

    pub fn runs(&self) -> &RunRegistry {
        todo!()
    }

    pub fn options(&self) -> &ServerOptions {
        todo!()
    }

    /// The port the server is bound to (the real one when `0` was asked for).
    pub fn port(&self) -> u16 {
        todo!()
    }

    /// The host the server is bound to.
    pub fn host(&self) -> &str {
        todo!()
    }

    /// A registered session view by name.
    pub fn session_view(&self, name: &str) -> Option<Arc<dyn SessionView>> {
        todo!()
    }
}

/// Assembles a server from a harness, options, features and session views.
pub struct ServerBuilder {
    harness: Harness,
    options: ServerOptions,
    events: EventHub,
    runs: RunRegistry,
    features: Vec<Box<dyn Feature>>,
    views: BTreeMap<String, Arc<dyn SessionView>>,
}

impl ServerBuilder {
    pub fn new(harness: Harness, options: ServerOptions) -> Self {
        todo!()
    }

    /// The hub the server will stream from, so the binary can bridge the event bus into it before start.
    pub fn events(&self) -> EventHub {
        todo!()
    }

    /// The run registry, shared with anything that needs to know which sessions are running.
    pub fn runs(&self) -> RunRegistry {
        todo!()
    }

    /// Mount a feature's routes.
    pub fn mount(self, feature: impl Feature) -> Self {
        todo!()
    }

    /// Register a `?view=<name>` projection of `GET /api/sessions/{id}`.
    pub fn session_view(self, name: impl Into<String>, view: Arc<dyn SessionView>) -> Self {
        todo!()
    }

    /// The router and its state without a socket, for tests that drive it with `tower::ServiceExt`.
    /// `port` stands in for the bound port; the secret is read from (or created at) the options' path.
    pub fn into_router(self, port: u16) -> Result<(Router, AppState), ServerError> {
        todo!()
    }

    /// Refuse a non-loopback host, read the secret, mint the token, bind, and serve in the background.
    /// Returns once the socket is listening, so the caller can print the URL without racing it.
    pub async fn start(self) -> Result<WebServer, ServerError> {
        todo!()
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
}

impl WebServer {
    /// `http://<host>:<port>/?token=<token>`.
    pub fn url(&self) -> &str {
        todo!()
    }

    pub fn token(&self) -> &str {
        todo!()
    }

    pub fn host(&self) -> &str {
        todo!()
    }

    /// The bound port.
    pub fn port(&self) -> u16 {
        todo!()
    }

    pub fn state(&self) -> &AppState {
        todo!()
    }

    /// The two lines `heddle web` prints once listening:
    /// `heddle web: <url>` and `heddle web: serving on <host>:<port>; pass --port to change it`.
    /// The verifiers wait for the first.
    pub fn announce(&self) -> [String; 2] {
        todo!()
    }

    /// What `--json` adds: `{"url","host","port","token"}` on one line.
    pub fn announce_json(&self) -> String {
        todo!()
    }

    /// Stop, streams and all: detach the approval answerer, end every stream subscriber, stop accepting,
    /// and close the connections that remain — an event stream is open by design, so waiting for it to
    /// end on its own would never return.
    pub async fn close(self) {
        todo!()
    }
}
