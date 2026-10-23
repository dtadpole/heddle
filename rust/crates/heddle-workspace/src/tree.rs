//! The folder tree the Web UI's left column shows and `heddle tree` prints.
//!
//! Ported from `tree`, `kindOf`, `classify` and `badgeFor` in `src/session/tree.ts`. A **derivation**,
//! not a service: it is handed the roots, the sessions and the generated names, and answers with nodes.
//!
//! - **One level at a time.** `children` is the direct children when that node was asked for, `null`
//!   when it was not, and `[]` for a file or a session (asked, and nothing to show).
//! - **Folders, then files**, each in [`crate::compare_names`] order. Dot-entries, `node_modules` and
//!   `__pycache__` are never listed.
//! - **Classification by the conventions' rules**: `_plural_noun_` is a `type`; a two-to-four-word
//!   kebab-case folder directly inside a type is an `instance`; a declared generated name is
//!   `generated`; a registered root is a `workspace`; anything else is a `folder`.
//! - **A session shows only on an instance** whose folder is that session's `cwd` (the newest such
//!   session), unless a definition under the instance's own `_sessions_` names the same session.
//! - **`_sessions_` is not a node.** Its instances are hoisted to the top of their branch as `session`
//!   rows — pinned first (most recently pinned first), then most recently updated — each carrying the
//!   session its `session.json` names, with the store's turns, title and flags.
//! - **The virtual root** lists the top-level roots a person registered as `children` and the adopted
//!   (`auto`) ones as `adHoc`.
//!
//! A path outside every root is classified `folder` here; refusing it is the caller's decision (an
//! error on the command line, a `400` over HTTP).
//!
//! # JSON
//!
//! A node serializes `path`, `kind`, `label`, `badge`, `session`, then `pinned`, `pinnedAt`, `archived`
//! when set, then `children` (always present, possibly `null`), then `bytes` for a file and `adHoc` on
//! the virtual root — the TypeScript build's key order for every node kind.

use std::collections::HashSet;

use serde::Serialize;

use heddle_session::SessionMeta;

use crate::record::{WorkspaceOrigin, WorkspaceRecord};

/// What a node is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Roots,
    Workspace,
    Type,
    Instance,
    Folder,
    Generated,
    File,
    Session,
}

/// What a session contributes to its row. Serialized `{ id, turns, created, title?, updated? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeSession {
    pub id: String,
    pub turns: u64,
    pub created: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
}

/// One node of the tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeNode {
    pub path: String,
    pub kind: NodeKind,
    pub label: String,
    /// The type's badge, for a type folder; `null` everywhere else.
    pub badge: Option<String>,
    pub session: Option<TreeSession>,
    /// A session row's pin.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    #[serde(rename = "pinnedAt", skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<String>,
    /// A session row the owner archived (drawn only when archived sessions were asked for).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    /// Direct children when asked for, `null` when not, `[]` for a leaf.
    pub children: Option<Vec<TreeNode>>,
    /// A file's size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// The adopted roots, on the virtual root only.
    #[serde(rename = "adHoc", skip_serializing_if = "Option::is_none")]
    pub ad_hoc: Option<Vec<TreeNode>>,
}

/// A registered root, as the tree needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRoot {
    pub path: String,
    pub title: String,
    /// `None` reads as a root a person registered.
    pub origin: Option<WorkspaceOrigin>,
}

impl From<&WorkspaceRecord> for TreeRoot {
    fn from(record: &WorkspaceRecord) -> Self {
        TreeRoot {
            path: record.path.clone(),
            title: record.title.clone(),
            origin: Some(record.origin),
        }
    }
}

/// Which archived sessions to draw — DSH's three states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ArchivedFilter {
    /// The default: a row a person put away is not one they asked for.
    #[default]
    Hide,
    Show,
    /// Only the archived ones: "where did it go".
    Only,
}

/// Everything a tree is derived from.
#[derive(Debug, Clone, Default)]
pub struct TreeInput {
    pub roots: Vec<TreeRoot>,
    /// Every session, in any order; the newest bound to a folder is that folder's session.
    pub sessions: Vec<SessionMeta>,
    /// Folder names a tool writes: the configured ones plus any `--generated`.
    pub generated: Vec<String>,
    pub archived: ArchivedFilter,
}

/// A type's badge: the name without underscores, vowels dropped, first three letters, uppercased; the
/// full name supplies letters when fewer than three consonants remain. `context` is `CTX` by the owner's
/// correction of 2026-10-11. `_tools_` → `TLS`, `_verifiers_` → `VRF`, `_conventions_` → `CNV`.
pub fn badge_for(name: &str) -> String {
    todo!()
}

/// What a folder is, given what its parent is.
pub fn classify(name: &str, parent: NodeKind, generated: &HashSet<String>) -> NodeKind {
    todo!()
}

/// What a path is, classified segment by segment from the nearest root above it. A path that is not a
/// directory is a `file`; a registered root is a `workspace`; a path under no root is a `folder`; the
/// segment after `_sessions_` is a `session`, and `_sessions_` itself, asked for directly, is a `type`.
pub fn kind_of(path: &str, input: &TreeInput) -> NodeKind {
    todo!()
}

/// One level of the tree: the virtual root when `path` is `None` or empty, otherwise that path's node
/// with its direct children (a file's own row when the path is not a directory).
pub fn tree(path: Option<&str>, input: &TreeInput) -> TreeNode {
    todo!()
}
