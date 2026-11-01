//! What the workspace service refuses, with the TypeScript build's words.

use thiserror::Error;

/// The code of [`WorkspaceError::RegistryUnreadable`], which a route answers `500` (#196).
pub const REGISTRY_UNREADABLE: &str = "workspace/registry-unreadable";

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
    /// `cannot list "<name>": permission denied` — a folder the tree was asked for and may not read (#106),
    /// named relative to its workspace (a root by its title). DSH's file backend says the same of such a
    /// folder (dsh-fs-local lib/index.js:269); DSH has no code for it, so the route answers heddle's
    /// `workspace-file/unreadable` ([`WorkspaceError::code`]), `400` as the folder picker answers
    /// `directory-picker/unreadable`.
    #[error("cannot list \"{name}\": permission denied")]
    Unreadable { name: String },
    /// `the workspace list could not be read: <file name>: <reason>` — the record file exists and does not read whole
    /// (#196): an I/O failure, bytes that are not UTF-8, an empty file, text that is not JSON, or JSON that is not a
    /// workspace list. Every read and every write answers it, and the route answers `500` with
    /// `workspace/registry-unreadable` ([`WorkspaceError::code`]). The sentence names the file by its name alone,
    /// because it reaches HTTP answers (#130's rule); `path` keeps the absolute path for the server's own line, and
    /// `detail` the parser's words, which say where (`WorkspaceRegistryUnreadable` in `src/workspace/service.ts`).
    /// DSH fails closed the same way: `invalid-record` (dsh-storage-domain lib/index.js:419-433), `malformed-medium`
    /// (dsh-storage-json lib/index.js:91-98), and no `backup-and-skip` for the workspace domain (dsh-workspace
    /// lib/index.js:255-268).
    #[error("the workspace list could not be read: {name}: {reason}")]
    RegistryUnreadable {
        path: String,
        name: String,
        reason: String,
        detail: Option<String>,
    },
}

impl WorkspaceError {
    /// The code a route answers beside the sentence: `workspace-file/unreadable` for
    /// [`WorkspaceError::Unreadable`], `workspace/registry-unreadable` for [`WorkspaceError::RegistryUnreadable`];
    /// `None` for every other error.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            WorkspaceError::Unreadable { .. } => Some("workspace-file/unreadable"),
            WorkspaceError::RegistryUnreadable { .. } => Some(REGISTRY_UNREADABLE),
            _ => None,
        }
    }
}
