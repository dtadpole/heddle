//! `GET /api/status` — what the composer needs to describe the machine it is talking to.
//!
//! Ported from the `/api/status` route of `src/server/web.ts`. `sandbox.mode` is the **deployment default**:
//! the mode a session starts from and the one the access chip reports while no session is open. A session that
//! switched does not appear here — its own mode travels with `GET /api/sessions/{id}` (the server's route).

use std::sync::Arc;

use serde::Serialize;

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
    let _ = host;
    todo!("status_view")
}

/// `GET /api/status`.
pub fn routes<H: StatusHost>(host: Arc<H>) -> axum::Router {
    let _ = host;
    todo!("status::routes")
}
