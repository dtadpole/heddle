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
//! | Route | Module | Host trait | Mounted by [`router`]? |
//! |---|---|---|---|
//! | `GET /api/context?session=&endpoint=&model=` | [`context_view`] | [`ContextHost`] | yes |
//! | `GET /api/endpoints` | [`model_switcher`] | [`ModelHost`] | yes |
//! | `POST /api/sessions/{id}/model` | [`model_switcher`] | [`ModelHost`] | yes |
//! | `GET /api/status` | [`status`] | [`StatusHost`] | **no** — `heddle-server`'s `CORE_ROUTES` owns it |
//! | `POST /api/sessions/{id}/steer` | [`turn_control`] | [`TurnControlHost`] | **no** — the server's turn registry owns it |
//! | `POST /api/sessions/{id}/stop` | [`turn_control`] | [`TurnControlHost`] | **no** — the server's turn registry owns it |
//!
//! The last three are **not** mounted here, and their `(method, path)` pairs are not advertised in [`ROUTES`]: the
//! server registers them itself (its `RunRegistry` owns steer and stop, and `/api/status` is the deployment's
//! sandbox mode and root), and a mount that collided would fail the binary's start-up with a route error rather
//! than a duplicate handler. Their modules, their [`StatusHost`]/[`TurnControlHost`] traits and their route
//! functions stay in this crate — with the same answers and their tests — because their logic is the composer's;
//! only the merged router and the advertised list are the three that the server does not have.
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
pub mod js;
pub mod model_switcher;
pub mod session;
pub mod status;
pub mod turn_control;

#[cfg(test)]
pub(crate) mod test_support;

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

/// Every `(method, path)` [`router`] mounts, in axum 0.8 path syntax.
///
/// The server registers routes of its own, and its mount rejects an overlapping path at start-up, so a caller can
/// assert the two sets are disjoint instead of meeting that error: `heddle-server` owns `/api/status`,
/// `/api/sessions/{id}/steer`, `/api/sessions/{id}/stop`, `/api/turn`, `/api/sessions`,
/// `/api/sessions/{id}`, `/api/sessions/{id}/permission`, `/api/tree`, `/api/workspaces`,
/// `/api/folders/session`, the goal and approval routes, and everything else in `web.ts`.
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/context"),
    ("GET", "/api/endpoints"),
    ("POST", "/api/sessions/{id}/model"),
];

/// The composer's routes, ready to be merged into the server's router.
///
/// The returned router has its state applied, so it merges into any `Router<()>`. It carries no
/// authentication of its own: the server wraps the merged router in its token and fence layers.
pub fn router<H: ComposerHost>(host: Arc<H>) -> axum::Router {
    axum::Router::new()
        .merge(context_view::routes(Arc::clone(&host)))
        .merge(model_switcher::routes(host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{Host, body_text, call};
    use axum::Router;
    use axum::http::{Method, StatusCode, header};

    #[test]
    fn every_route_is_listed_once_and_every_answered_path_is_listed() {
        for (index, route) in ROUTES.iter().enumerate() {
            assert!(
                !ROUTES[index + 1..].contains(route),
                "{route:?} is listed twice"
            );
        }
        for (method, path) in [
            ("GET", "/api/context"),
            ("GET", "/api/endpoints"),
            ("POST", "/api/sessions/{id}/model"),
        ] {
            assert!(
                ROUTES.contains(&(method, path)),
                "{method} {path} is answered but not listed"
            );
        }
        // The server's `CORE_ROUTES` own these three; advertising them here would make the binary's mount fail.
        for (method, path) in [
            ("GET", "/api/status"),
            ("POST", "/api/sessions/{id}/steer"),
            ("POST", "/api/sessions/{id}/stop"),
        ] {
            assert!(
                !ROUTES.contains(&(method, path)),
                "{method} {path} is the server's route and must not be mounted here"
            );
        }
    }

    /// A caller's layer, the token decision in miniature.
    async fn stamp(
        request: axum::extract::Request,
        next: axum::middleware::Next,
    ) -> axum::response::Response {
        let mut response = next.run(request).await;
        response.headers_mut().insert(
            header::HeaderName::from_static("x-stamped"),
            header::HeaderValue::from_static("yes"),
        );
        response
    }

    #[tokio::test]
    async fn the_router_merges_into_a_callers_router_and_its_layer_covers_both() {
        // What the server or the binary does: its own state applied, then this router merged, then one layer.
        let caller = Router::new()
            .route("/api/health", axum::routing::get(|| async { "ok" }))
            .with_state(());
        let app = caller
            .merge(router(Arc::new(Host::default())))
            .layer(axum::middleware::from_fn(stamp));

        let response = call(app.clone(), Method::GET, "/api/health", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_text(response).await, "ok");

        let response = call(app.clone(), Method::GET, "/api/endpoints", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["x-stamped"],
            "yes",
            "the caller's layer covers the merged routes too"
        );
        // And the three the server owns are **not** here: mounting them would fail the binary's start-up.
        let response = call(app, Method::GET, "/api/status", None).await;
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "/api/status is the server's route, not this router's"
        );
    }
}
