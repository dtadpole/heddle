//! The Trajectory view's HTTP surface.
//!
//! | Request | Answer |
//! |---|---|
//! | any of the two, id not `session-<uuid>` | `400 {"error":"not a session id"}` |
//! | any of the two, no such session | `404 {"error":"no session <id>"}` |
//! | `GET /api/sessions/{id}?view=ledger` | `200` [`LedgerView`](crate::LedgerView), pretty — through [`ledger_response`], called by the server's chat route |
//! | `GET /api/sessions/{id}/log` | `200 application/x-ndjson; charset=utf-8`, `content-disposition` from [`log_file_name`](crate::log_file_name), `content-length` — mounted by [`router`] |

use std::sync::Arc;

use axum::response::Response;
use heddle_web_composer::{SessionLookup, ToolSpec};

use crate::inspector::JsonHighlighter;

/// What the Trajectory routes read from the running harness.
pub trait TrajectoryHost: SessionLookup + JsonHighlighter {
    /// The session's title as the store lists it (`ctx.session.list()`), when it has one.
    fn session_title(&self, id: &str) -> Option<String>;
    /// The profile's tools as the tool service describes them (`ctx.tools.describe()`).
    fn tool_specs(&self) -> Vec<ToolSpec>;
}

/// The answer to `GET /api/sessions/{id}?view=ledger`, for the server's chat route to return when the query asks
/// for the ledger. `id` is the decoded path segment.
pub fn ledger_response<H: TrajectoryHost + ?Sized>(host: &H, id: &str) -> Response {
    let _ = (host, id);
    todo!("ledger_response")
}

/// The answer to `GET /api/sessions/{id}/log`.
pub fn log_response<H: TrajectoryHost + ?Sized>(host: &H, id: &str) -> Response {
    let _ = (host, id);
    todo!("log_response")
}

/// The routes this crate mounts: `GET /api/sessions/{id}/log`.
pub fn router<H: TrajectoryHost>(host: Arc<H>) -> axum::Router {
    let _ = host;
    todo!("trajectory::router")
}
