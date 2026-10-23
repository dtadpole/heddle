//! `heddle-web-trajectory` — the trajectory view routes, the ledger and log download.
//!
//! Ported from the TypeScript build: `src/server/ledger.ts`, `src/server/log-download.ts`,
//! `src/server/tool-inspector.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`) by
//! `_verifiers_/85-trajectory-view` and `_verifiers_/80-web-ui` (check-trajectory-view, and the ledger half of
//! check-runtime-context); the session statistics feed check-composer's dock.
//!
//! # Shape
//!
//! Almost everything here is a **pure projection** of one session's recorded events: the same events always give
//! the same answer, and nothing writes. Events arrive as the JSON objects the log holds (`serde_json::Value`, key
//! order kept), so the crate reads the fields it needs and depends on no session type.
//!
//! | Projection | Module | Feeds |
//! |---|---|---|
//! | events → [`Ledger`] (turns, steps, records, totals) | [`ledger`] | `?view=ledger` |
//! | ledger → table rows, previews, lanes | [`rows`] | `?view=ledger` |
//! | ledger → [`Timeline`] (the lane strip) | [`timeline`] | `?view=ledger` |
//! | events → [`SessionStats`] (the composer's dock) | [`stats`] | the chat view's `stats` |
//! | tool row → highlighted inspector blocks | [`inspector`] | `?view=ledger` |
//! | title → download file name, events → NDJSON | [`log_download`] | `/log` |
//!
//! # Routes
//!
//! | Route | Owner of the route | This crate provides |
//! |---|---|---|
//! | `GET /api/sessions/{id}?view=ledger` | the server (one route, two views) | [`routes::ledger_response`] |
//! | `GET /api/sessions/{id}` (chat view) `stats` | the server | [`stats::session_stats_view`] |
//! | `GET /api/sessions/{id}/log` | this crate | [`routes::router`] |
//!
//! The ledger is served from the chat route's own path because two routes are how two views of one record start
//! to disagree; axum cannot route on a query, so the server's handler calls [`routes::ledger_response`] when
//! `view=ledger`.
//!
//! # The three rules copied from DSH
//!
//! - **An in-flight record has a start and no duration.**
//! - **An unavailable number is absent, not zero** — every optional count is `Option` and skipped when `None`.
//! - **A record's timing comes from its own events**; nothing interpolates a missing timestamp.

pub mod inspector;
mod js_json;
pub mod ledger;
pub mod log_download;
pub mod routes;
pub mod rows;
pub mod stats;
pub mod timeline;
pub mod usage;
pub mod view;

#[cfg(test)]
pub(crate) mod test_support;

pub use inspector::{JsonHighlighter, ToolInspection, inspect_tool, render_payload};
pub use ledger::{
    Ledger, LedgerKind, LedgerRecord, LedgerStep, LedgerTokens, LedgerTurn, ToolState, UsageSource,
    project_ledger,
};
pub use log_download::{content_disposition, log_file_name, ndjson};
pub use routes::{TrajectoryHost, ledger_response, router};
pub use rows::{LedgerLane, LedgerRow, lane_of, preview_of, project_rows};
pub use stats::{
    BreakdownChoice, BreakdownSource, ContextBreakdown, MeasuredSurface, SessionStats,
    SessionStatsView, context_breakdown_with_fallback, project_session_stats, session_stats_view,
};
pub use timeline::{Timeline, TimelineSpan, project_timeline};
pub use usage::TokenUsage;
pub use view::{LedgerView, LedgerViewRow, ledger_view};
