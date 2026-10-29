//! `heddle-commands` — the host's slash commands: the registry, the line parser, the built-in commands and the
//! two routes the composer's slash menu uses.
//!
//! Ported from the TypeScript build's `src/commands/` (`registry.ts`, `builtins.ts`, `http.ts`, `service.ts`),
//! which is modelled on DSH's `dsh-commands`. Judged through the `heddle` binary (`HEDDLE_BIN`) by
//! `_verifiers_/80-web-ui/check-slash-commands.mjs`; the unit tests port `test/commands.test.ts` case by case.
//!
//! # The one rule
//!
//! A line that opens with `/name` and names a registered command runs **on the host**: it never becomes a
//! prompt, and the session log records a `command/run` before the handler and a `command/done` after it, both
//! log-only (no place on the model's surface). A line that names no command is left alone — nothing is
//! written — and the page sends it as an ordinary prompt, which is DSH's rule and how `/skillname` reaches the
//! model.
//!
//! | Module | Ports | What it is |
//! |---|---|---|
//! | [`registry`] | `registry.ts` | [`CommandRegistry`], [`parse_command_line`], the two event names, the result shapes |
//! | [`builtins`] | `builtins.ts` | `/compact`, `/goal`, `/feedback`, `/permission`, `/export`, each over the smallest host it needs |
//! | [`routes`] | `http.ts` | `GET /commands/menu.js`, `GET /api/commands` and `POST /api/sessions/{id}/commands` |
//! | [`service`] | `service.ts` | [`Commands`]: the registry with the built-ins wired to the session, goal, context, model and sandbox facts |
//!
//! # Mounting
//!
//! The binary builds [`Commands`] from its booted services ([`CommandServices`]) — with the upload directory its
//! turn route reads attachments from — and merges [`router`] behind the server's door. [`ROUTES`] lists the three
//! `(method, path)` pairs, which no server route claims.

pub mod builtins;
pub mod registry;
pub mod routes;
pub mod service;
mod text;

#[cfg(test)]
pub(crate) mod test_support;

use std::sync::Arc;

pub use builtins::{
    AnonymousUser, CompactionHost, CompactionOutcome, FEEDBACK_EVENT, GoalHost, GoalLike,
    GoalRefLike, PermissionHost, compact_command, describe_goal, export_command, feedback_command,
    goal_command, permission_command,
};
pub use registry::{
    COMMAND_DONE_EVENT, COMMAND_NAME_RULE, COMMAND_RUN_EVENT, CommandAction, CommandContext,
    CommandDefinition, CommandDescriptor, CommandError, CommandExecution, CommandHandler,
    CommandInput, CommandLog, CommandRegistry, CommandResult, CommandSection, Disposer,
    HandlerOutcome, ParsedLine, RegistrationError, default_label, is_command_name,
    parse_command_line,
};
pub use routes::{MAX_COMMAND_LINE, MENU_PATH, MENU_SOURCE};
pub use service::{
    CommandServices, Commands, NO_CONTEXT_SERVICE, NO_GOAL_SERVICE, NO_SUMMARY_ENDPOINT,
    anonymous_user,
};

/// Every `(method, path)` [`router`] mounts, in axum 0.8 path syntax. The session segment is named `{id}`, as
/// every route under `/api/sessions/` must name it for the server's router to merge them.
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/commands/menu.js"),
    ("GET", "/api/commands"),
    ("POST", "/api/sessions/{id}/commands"),
];

/// The profile's `commands` row, as the binary's boot provides it: its presence is what turns the routes on, the way
/// the TypeScript server hands over only when `ctx.get('commands')` exists. The commands themselves are built by
/// [`router`]'s caller once the services they drive have started.
#[derive(Debug, Clone, Copy, Default)]
pub struct CommandsRow;

/// The command routes, ready to be merged into the server's router.
///
/// The returned router has its state applied, so it merges into any `Router<()>`. It carries no
/// authentication of its own: the server wraps the merged router in its token and fence layers.
pub fn router(host: Arc<Commands>) -> axum::Router {
    routes::routes(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{Fixture, call};
    use axum::http::{Method, StatusCode};
    use heddle_session::SessionService;

    #[test]
    fn every_route_is_listed_once() {
        for (index, route) in ROUTES.iter().enumerate() {
            assert!(!ROUTES[index + 1..].contains(route), "{route:?} twice");
        }
        assert!(ROUTES.contains(&("GET", MENU_PATH)));
    }

    #[tokio::test]
    async fn the_router_merges_into_a_callers_router_beside_its_session_routes() {
        let fixture = Fixture::new("lib-merge");
        let commands = Commands::new(CommandServices {
            sessions: Arc::new(SessionService::from_store(fixture.store.clone())),
            goals: None,
            context: None,
            models: None,
            sandbox_default: heddle_sandbox::SandboxMode::WorkspaceWrite,
            heddle_home: fixture.root.join("home"),
            upload_dir: fixture.upload_dir(),
        });
        // The server's own routes under `/api/sessions/{id}`, named the same way: the merge must not panic.
        let caller = axum::Router::new()
            .route(
                "/api/sessions/{id}/log",
                axum::routing::get(|| async { "log" }),
            )
            .route(
                "/api/sessions/{id}",
                axum::routing::get(|| async { "session" }),
            );
        let app = caller.merge(router(Arc::new(commands)));
        let listed = call(app.clone(), Method::GET, "/api/commands", None).await;
        assert_eq!(listed.status(), StatusCode::OK);
        let log = call(
            app,
            Method::GET,
            &format!("/api/sessions/{}/log", fixture.handle.id),
            None,
        )
        .await;
        assert_eq!(log.status(), StatusCode::OK);
    }
}
