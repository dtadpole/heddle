//! What the workspace service refuses, with the TypeScript build's words.

use thiserror::Error;

/// A workspace operation that could not be done.
#[derive(Debug, Error)]
pub enum WorkspaceError {
    /// The record file could not be written. Carries the path.
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// `no workspace '<id-or-path>'` — a `404` on the route.
    #[error("no workspace '{0}'")]
    NotFound(String),
    /// `a workspace needs a name` — a rename to a blank title.
    #[error("a workspace needs a name")]
    EmptyName,
    /// `A workspace named “<title>” already exists.` — a rename to a title another workspace a person chose
    /// already carries; DSH's `workspace/name-conflict`, a `409` on the route.
    #[error("A workspace named “{0}” already exists.")]
    NameConflict(String),
    /// `cannot reorder unknown workspace '<id-or-path>'` — a reorder naming a workspace, or an anchor, that is
    /// not in the order: DSH's `WorkspaceOrderInvalidError` (dsh-workspace lib/index.js:333-344), which the
    /// route answers `404` with DSH's `workspace/not-found`.
    #[error("cannot reorder unknown workspace '{0}'")]
    OrderInvalid(String),
    /// Removing a root that still holds sessions with nothing above it — a `409` on the route:
    /// `workspace '<title>' still holds <n> session(s) and no root above it, so removing it would only be
    /// undone on the next run; remove those sessions, register a root above '<path>', or force it`
    #[error(
        "workspace '{title}' still holds {sessions} session(s) and no root above it, so removing it would only be undone on the next run; remove those sessions, register a root above '{path}', or force it"
    )]
    StillHoldsSessions {
        title: String,
        path: String,
        sessions: usize,
    },
}
