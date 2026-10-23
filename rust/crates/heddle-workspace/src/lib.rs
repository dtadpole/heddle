//! `heddle-workspace` — workspaces, the folders they name, and the classified recursive tree.
//!
//! Ported from the TypeScript build: `src/workspace/service.ts`, and `src/session/tree.ts` (the folder
//! tree and the file reader), which lives here because the tree is a view of the workspace roots.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/70-workspaces-sessions` and
//! `_verifiers_/80-web-ui` (`check-workspaces`).
//!
//! # The model
//!
//! - **A workspace is a record and a folder.** `{ id, path, title, origin, createdAt, updatedAt }` in one
//!   file, `$HEDDLE_HOME/workspaces.json`, ordered by `workspaceIds` ([`record`], [`service`]).
//! - **Association is containment, by path segment, and the nearest root owns a session.** A session
//!   bound to any folder at or below a root is a member; `/a/b-sibling` is not inside `/a/b`. Membership
//!   is derived from each session's `cwd` on every read, never stored.
//! - **Every session has a root.** `bootstrap` adopts (`origin: auto`) the folder of any session nothing
//!   owns; registering an adopted folder promotes it (`origin: added`).
//! - **The tree classifies folders by the conventions' own rules**, one level at a time: `_type_`
//!   folders, kebab-case instances inside them, plain folders, generated folders, files; a branch's
//!   `_sessions_` instances hoisted to its top as session rows ([`mod@tree`]).
//!
//! # Status
//!
//! Every module is ported, with the unit tests the crate's `INDEX.md` port plan names. What is not yet
//! judged is the command line and the page that call it: `_verifiers_/70-workspaces-sessions` and
//! `_verifiers_/80-web-ui` (`check-workspaces`) judge this crate through the `heddle` binary.

pub mod collate;
pub mod error;
pub mod file;
pub mod record;
pub mod service;
pub mod tree;

pub use collate::compare_names;
pub use error::WorkspaceError;
pub use file::{FILE_LIMIT_BYTES, FileReadError, FileReading, read_file_text};
pub use record::{
    BootstrapReport, WorkspaceAddition, WorkspaceOrigin, WorkspaceRecord, WorkspaceRemoval,
    WorkspaceStoreShape, listing_row,
};
pub use service::{WorkspaceConfig, WorkspaceService, default_workspace_file};
pub use tree::{
    ArchivedFilter, NodeKind, TreeInput, TreeNode, TreeRoot, TreeSession, badge_for, classify,
    kind_of, tree,
};
