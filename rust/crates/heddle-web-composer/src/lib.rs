//! `heddle-web-composer` — the composer routes: runtime context, the context view, the model switcher and the
//! tool catalog.
//!
//! Ported from the TypeScript build: `src/server/tool-catalog.ts` and the composer routes of
//! `src/server/web.ts`. Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/80-web-ui`
//! (check-composer, check-context-view, check-runtime-context, check-model-switcher).
//!
//! # Shape
//!
//! The crate owns **routes**, not state. Everything a route reads or changes — the session store, the context
//! assembler, the model service, the turn registry — is reached through a *host* trait declared here, so the
//! crate builds and is unit-tested against doubles before the crates that hold that state exist. The server
//! (or the binary) implements the traits over the real crates and mounts [`router`]; authentication, the
//! Host/Origin fence and the `404` fallback are the server's, applied around the merged router.
//!
//! | Route | Module | Host trait |
//! |---|---|---|
//! | `GET /api/status` | [`status`] | [`StatusHost`] |
//! | `GET /api/context?session=&endpoint=&model=` | [`context_view`] | [`ContextHost`] |
//! | `GET /api/endpoints` | [`model_switcher`] | [`ModelHost`] |
//! | `POST /api/sessions/{id}/model` | [`model_switcher`] | [`ModelHost`] |
//! | `POST /api/sessions/{id}/steer` | [`turn_control`] | [`TurnControlHost`] |
//! | `POST /api/sessions/{id}/stop` | [`turn_control`] | [`TurnControlHost`] |
//!
//! Every answer keeps the TypeScript build's status codes, error sentences and body bytes
//! (`JSON.stringify(value, null, 2)` plus a newline, `cache-control: no-store`), because the page and the
//! verifiers read them.
//!
//! The tool catalog ([`catalog`]) is pure shaping used by the Trajectory view's details pane; it lives here as
//! the crate's assignment names it, and `heddle-web-trajectory` depends on it.

pub mod catalog;
pub mod context_view;
pub mod http;
pub mod model_switcher;
pub mod session;
pub mod status;
pub mod turn_control;

use std::sync::Arc;

pub use catalog::{ToolSchema, ToolSpec, catalog_of, schema_for};
pub use context_view::ContextHost;
pub use model_switcher::ModelHost;
pub use session::SessionLookup;
pub use status::StatusHost;
pub use turn_control::TurnControlHost;

/// Everything the composer's routes need from the running harness, in one bound.
///
/// Blanket-implemented: a type that implements the four host traits is a `ComposerHost`.
pub trait ComposerHost: StatusHost + ContextHost + ModelHost + TurnControlHost {}

impl<T: StatusHost + ContextHost + ModelHost + TurnControlHost> ComposerHost for T {}

/// The composer's routes, ready to be merged into the server's router.
///
/// The returned router has its state applied, so it merges into any `Router<()>`. It carries no
/// authentication of its own: the server wraps the merged router in its token and fence layers.
pub fn router<H: ComposerHost>(host: Arc<H>) -> axum::Router {
    axum::Router::new()
        .merge(status::routes(Arc::clone(&host)))
        .merge(context_view::routes(Arc::clone(&host)))
        .merge(model_switcher::routes(Arc::clone(&host)))
        .merge(turn_control::routes(host))
}
