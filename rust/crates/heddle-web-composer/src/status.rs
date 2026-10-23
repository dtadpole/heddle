//! `GET /api/status` — what the composer needs to describe the machine it is talking to.
//!
//! Ported from the `/api/status` route of `src/server/web.ts`. `sandbox.mode` is the **deployment default**:
//! the mode a session starts from and the one the access chip reports while no session is open. A session that
//! switched does not appear here — its own mode travels with `GET /api/sessions/{id}` (the server's route).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use serde::Serialize;

use crate::http::json_compact;

/// What `/api/status` reads from the running harness.
pub trait StatusHost: Send + Sync + 'static {
    /// The sandbox's deployment-default permission mode, e.g. `workspace-write` (`ctx.sandbox.mode`).
    fn sandbox_mode(&self) -> String;
    /// The sandbox's workspace root (`ctx.sandbox.workspaceRoot`); `None` serialises as `null`.
    fn workspace_root(&self) -> Option<String>;
}

/// The body of `GET /api/status`: `{"sandbox":{"mode":"..."},"cwd":"..."}`, compact.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatusView {
    pub sandbox: SandboxStatus,
    pub cwd: Option<String>,
}

/// The `sandbox` member of [`StatusView`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SandboxStatus {
    pub mode: String,
}

/// The status a host reports, shaped for the page.
pub fn status_view<H: StatusHost + ?Sized>(host: &H) -> StatusView {
    StatusView {
        sandbox: SandboxStatus {
            mode: host.sandbox_mode(),
        },
        cwd: host.workspace_root(),
    }
}

/// `GET /api/status`.
pub fn routes<H: StatusHost>(host: Arc<H>) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/status",
            get(move |State(host): State<Arc<H>>| async move {
                json_compact(StatusCode::OK, &status_view(&*host))
            }),
        )
        .with_state(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;

    use crate::test_support::{Host, assert_answer_headers, body_text, call};

    #[tokio::test]
    async fn the_status_answers_the_deployment_mode_and_the_workspace_root() {
        let router = routes(Arc::new(Host::default()));
        let response = call(router, Method::GET, "/api/status", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_answer_headers(&response, crate::http::JSON_CONTENT_TYPE);
        assert_eq!(
            body_text(response).await,
            "{\"sandbox\":{\"mode\":\"workspace-write\"},\"cwd\":\"/tmp/workspace\"}\n"
        );
    }

    #[tokio::test]
    async fn a_host_without_a_workspace_root_says_null_rather_than_inventing_one() {
        let host = Host {
            workspace_root: None,
            ..Host::default()
        };
        let router = routes(Arc::new(host));
        let response = call(router, Method::GET, "/api/status", None).await;
        assert_eq!(
            body_text(response).await,
            "{\"sandbox\":{\"mode\":\"workspace-write\"},\"cwd\":null}\n"
        );
    }
}
