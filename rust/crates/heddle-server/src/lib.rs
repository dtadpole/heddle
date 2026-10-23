//! `heddle-server` — the HTTP server, the token, the live stream and the page it serves.
//!
//! Ported from the TypeScript build: `src/server/web.ts`, `src/server/token.ts`, `src/server/html.ts`,
//! and `src/server/page.html`, which is **embedded, not rewritten** — one page serves both builds.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/80-web-ui` (check, check-chat-view,
//! check-access), `_verifiers_/87-resizable-panels` and `_verifiers_/90-web-ui-token`.
//!
//! # Shape
//!
//! The TypeScript server is one `node:http` handler over a Cordis context. The port splits it along the
//! seams the team works on:
//!
//! - **The door** — [`token`], [`fence`] and [`page`]: the launch token, the authority-bound cookie, the
//!   Host/Origin fence and the token form. Pure functions, judged without a socket.
//! - **The stream** — [`stream`]: one [`stream::EventHub`] that every session event and approval question
//!   is published into, and the SSE framing both `/api/events` and `/api/turn` write.
//! - **The runs** — [`runs`]: which sessions have a turn in flight, since when, and the handle a stop
//!   cancels.
//! - **The seam to the harness** — [`services`]: the traits this server calls instead of a Cordis
//!   context. The binary composes real implementations; every test here uses doubles.
//! - **The routes** — [`server`]: the builder, the router and the shared [`server::AppState`]. A feature
//!   crate (trajectory, composer, files) contributes routes through [`server::Feature`] and inherits the
//!   fence and the token from this crate, so no feature can mount an unauthenticated route by accident.
//! - **Helpers every route uses** — [`respond`]: the response shapes, the JSON body reader and the
//!   session-id rule, so a feature crate answers exactly as the TypeScript server did.
//! - **Pure folds** — [`transcript`] (the chat view of a session's log) and [`selection`] (which endpoint,
//!   model and reasoning level a turn runs with).
//!
//! The public API landed first (contract first); bodies that still say `todo!()` are ported in the
//! order the crate's `INDEX.md` gives.

// The contract stage: signatures exist before their bodies. Removed once every body is ported.
#![allow(unused_variables, dead_code)]

pub mod fence;
pub mod page;
pub mod preview;
pub mod respond;
pub mod runs;
pub mod selection;
pub mod server;
pub mod services;
pub mod stream;
pub mod token;
pub mod transcript;

pub use server::{
    AppState, DEFAULT_HOST, DEFAULT_PORT, DryRunPlan, Feature, ServerBuilder, ServerError,
    ServerOptions, SessionView, WebServer,
};
pub use services::Harness;
pub use stream::{EventHub, SseFrame};
