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

use std::collections::{HashMap, HashSet};
use std::path::Path;

use heddle_config::{canonical_path, depth_of, is_under};
use serde::Serialize;

use heddle_session::SessionMeta;
use heddle_session::definition::{SessionDefinitionFields, read_session_definition};

use crate::collate::compare_names;
use crate::error::WorkspaceError;
use crate::record::{WorkspaceOrigin, WorkspaceRecord};

/// The type folder whose instances are a branch's sessions. Named, not classified: the tree gives the
/// conventions' name a shape.
const SESSIONS_FOLDER: &str = "_sessions_";

/// Folders nothing means by "content", so the tree does not enumerate them.
const PLUMBING: [&str; 2] = ["node_modules", "__pycache__"];

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
    let letters: String = name.replace('_', "").to_lowercase();
    if letters == "context" {
        return "CTX".to_string();
    }
    let consonants: String = letters
        .chars()
        .filter(|character| !matches!(character, 'a' | 'e' | 'i' | 'o' | 'u'))
        .collect();
    let source = if consonants.chars().count() >= 3 {
        consonants
    } else {
        letters
    };
    source.chars().take(3).collect::<String>().to_uppercase()
}

/// What a folder is, given what its parent is.
pub fn classify(name: &str, parent: NodeKind, generated: &HashSet<String>) -> NodeKind {
    if generated.contains(name) {
        return NodeKind::Generated;
    }
    if is_type_folder(name) {
        return NodeKind::Type;
    }
    if parent == NodeKind::Type && is_instance_name(name) {
        return NodeKind::Instance;
    }
    NodeKind::Folder
}

/// `^_[a-z0-9]+(_[a-z0-9]+)*_$` — a plural noun wrapped in underscores; a single underscore is not
/// enough.
fn is_type_folder(name: &str) -> bool {
    let Some(inner) = name
        .strip_prefix('_')
        .and_then(|rest| rest.strip_suffix('_'))
    else {
        return false;
    };
    !inner.is_empty()
        && inner.split('_').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
}

/// `^[a-z0-9]+(-[a-z0-9]+){1,3}$` — kebab-case, two to four lowercase words.
fn is_instance_name(name: &str) -> bool {
    let segments: Vec<&str> = name.split('-').collect();
    (2..=4).contains(&segments.len())
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
}

/// A path made absolute, lexically, and canonical when it exists.
fn canonical(path: &str) -> String {
    canonical_path(Path::new(path))
        .to_string_lossy()
        .into_owned()
}

/// Whether a path is a directory.
fn is_directory(path: &str) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

/// A file's size, or 0 when it cannot be read — an unreadable file is still a row.
fn size_of(path: &str) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

/// The last path segment, as `basename` reads it.
fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// One entry of a directory, with what the row needs.
struct Entry {
    name: String,
    directory: bool,
    bytes: u64,
}

/// One directory's entries worth showing: folders first, then files, each name-sorted; dot-entries and
/// the two noise directories are not returned at all.
fn entries(dir: &str) -> Vec<Entry> {
    // A folder *inside* a listing that cannot be read (a `_sessions_` drawer, say) has nothing to add to it.
    listed(dir).unwrap_or_default()
}

/// The entries of one directory, or the error that kept it from being read.
fn listed(dir: &str) -> std::io::Result<Vec<Entry>> {
    let read = std::fs::read_dir(dir)?;
    let mut entries: Vec<Entry> = read
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            !name.starts_with('.') && !PLUMBING.contains(&name.as_str())
        })
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            let path = Path::new(dir).join(&name).to_string_lossy().into_owned();
            Entry {
                name,
                directory,
                bytes: if directory { 0 } else { size_of(&path) },
            }
        })
        .collect();
    entries.sort_by(|left, right| {
        if left.directory == right.directory {
            compare_names(&left.name, &right.name)
        } else if left.directory {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    Ok(entries)
}

/// The entries of the folder the caller **asked for**: a folder it may not read is
/// [`WorkspaceError::Unreadable`], not an empty list (#106) — "nothing inside" was false, and the page
/// said it. Any other failure keeps the old answer, an empty level.
fn asked_entries(dir: &str, context: &Context) -> Result<Vec<Entry>, WorkspaceError> {
    match listed(dir) {
        Ok(entries) => Ok(entries),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(WorkspaceError::Unreadable {
                name: name_in_workspace(dir, context),
            })
        }
        Err(_) => Ok(Vec::new()),
    }
}

/// A folder as a person knows it: a root by its title, a folder by its path inside its root, else by
/// its name.
fn name_in_workspace(dir: &str, context: &Context) -> String {
    if let Some(root) = context.by_path.get(dir) {
        return root.title.clone();
    }
    match context.owner_of(dir) {
        Some(owner) => dir[owner.path.len()..]
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>()
            .join("/"),
        None => {
            let name = basename(dir);
            if name.is_empty() {
                dir.to_string()
            } else {
                name
            }
        }
    }
}

/// The newest session bound to each folder, so a folder row can be its session.
fn current_by_folder(sessions: &[SessionMeta]) -> HashMap<String, SessionMeta> {
    let mut map: HashMap<String, SessionMeta> = HashMap::new();
    for meta in sessions {
        let folder = canonical(meta.cwd());
        match map.get(&folder) {
            Some(seen) if seen.created() >= meta.created() => {}
            _ => {
                map.insert(folder, meta.clone());
            }
        }
    }
    map
}

/// Everything a derivation needs, built once per call.
struct Context {
    roots: Vec<TreeRoot>,
    by_path: HashMap<String, TreeRoot>,
    generated: HashSet<String>,
    sessions: HashMap<String, SessionMeta>,
    by_id: HashMap<String, SessionMeta>,
    archived: ArchivedFilter,
    /// The roots ordered nearest-first, for the "nearest root above" question.
    ordered: Vec<TreeRoot>,
}

impl Context {
    fn build(input: &TreeInput) -> Context {
        let roots: Vec<TreeRoot> = input
            .roots
            .iter()
            .map(|root| TreeRoot {
                path: canonical(&root.path),
                title: root.title.clone(),
                origin: root.origin,
            })
            .collect();
        let mut by_path = HashMap::new();
        for root in &roots {
            by_path.insert(root.path.clone(), root.clone());
        }
        let mut ordered = roots.clone();
        ordered.sort_by(|left, right| {
            depth_of(Path::new(&right.path)).cmp(&depth_of(Path::new(&left.path)))
        });
        Context {
            by_id: input
                .sessions
                .iter()
                .map(|meta| (meta.id().to_string(), meta.clone()))
                .collect(),
            sessions: current_by_folder(&input.sessions),
            generated: input.generated.iter().cloned().collect(),
            archived: input.archived,
            roots,
            by_path,
            ordered,
        }
    }

    /// The nearest root **strictly above** a path, or `None`.
    fn owner_of(&self, path: &str) -> Option<&TreeRoot> {
        let path = Path::new(path);
        self.ordered.iter().find(|root| {
            let root_path = Path::new(&root.path);
            root_path != path && is_under(root_path, path)
        })
    }
}

/// The session a `_sessions_` instance stands for: the definition names it, and the store fills in the
/// facts a row shows.
fn session_of(dir: &str, context: &Context) -> Option<TreeSession> {
    let definition = read_session_definition(dir)?;
    let meta = context.by_id.get(definition.id());
    let title = meta
        .and_then(|meta| meta.title().map(str::to_string))
        .or_else(|| definition.title().map(str::to_string));
    let created = match meta {
        Some(meta) => meta.created().to_string(),
        None => definition.created_at().unwrap_or("").to_string(),
    };
    Some(TreeSession {
        id: definition.id().to_string(),
        turns: meta.map(SessionMeta::turns).unwrap_or(0),
        created,
        title,
        updated: meta.and_then(|meta| meta.updated().map(str::to_string)),
    })
}

/// The session ids a folder's `_sessions_` folder names in its definitions.
fn captured_in(dir: &str) -> HashSet<String> {
    let mut ids = HashSet::new();
    for entry in entries(&Path::new(dir).join(SESSIONS_FOLDER).to_string_lossy()) {
        if !entry.directory {
            continue;
        }
        let session_dir = Path::new(dir).join(SESSIONS_FOLDER).join(&entry.name);
        if let Some(definition) = read_session_definition(&session_dir.to_string_lossy()) {
            ids.insert(definition.id().to_string());
        }
    }
    ids
}

/// A node without its children, which each caller adds.
fn row(
    context: &Context,
    path: &str,
    kind: NodeKind,
    label: &str,
    suppress_session: bool,
) -> TreeNode {
    let meta = if kind == NodeKind::Instance && !suppress_session {
        context.sessions.get(path)
    } else {
        None
    };
    TreeNode {
        path: path.to_string(),
        kind,
        label: label.to_string(),
        badge: if kind == NodeKind::Type {
            Some(badge_for(label))
        } else {
            None
        },
        session: meta.map(|meta| TreeSession {
            id: meta.id().to_string(),
            turns: meta.turns(),
            created: meta.created().to_string(),
            title: meta.title().map(str::to_string),
            updated: meta.updated().map(str::to_string),
        }),
        pinned: false,
        pinned_at: None,
        archived: false,
        children: None,
        bytes: None,
        ad_hoc: None,
    }
}

/// A `_sessions_` instance while its rows are being ordered.
struct Flagged {
    name: String,
    dir: String,
    definition: Option<SessionDefinitionFields>,
    pinned: bool,
    pinned_at: Option<String>,
    updated: Option<String>,
    archived: bool,
}

/// The direct children of a folder — its subfolders, its files, or a registered root among them — from
/// its `listing`.
fn children_of(dir: &str, kind: NodeKind, context: &Context, listing: Vec<Entry>) -> Vec<TreeNode> {
    let mut sessions: Vec<TreeNode> = Vec::new();
    let mut rest: Vec<TreeNode> = Vec::new();
    // Asked for **by name**, the sessions folder answers with sessions rather than with instances.
    let parent_is_sessions = basename(dir) == SESSIONS_FOLDER;

    for entry in listing {
        let path = canonical(&Path::new(dir).join(&entry.name).to_string_lossy());

        if entry.directory && entry.name == SESSIONS_FOLDER {
            // The sessions folder is **not a node**: its sessions are this branch's own, shown first.
            let mut flagged: Vec<Flagged> = entries(&path)
                .into_iter()
                .filter(|entry| entry.directory)
                .map(|entry| {
                    let session_dir = Path::new(&path)
                        .join(&entry.name)
                        .to_string_lossy()
                        .into_owned();
                    let definition = read_session_definition(&session_dir);
                    let meta = definition
                        .as_ref()
                        .and_then(|definition| context.by_id.get(definition.id()));
                    // The flags come from the store and nowhere else.
                    Flagged {
                        name: entry.name,
                        dir: session_dir,
                        definition,
                        pinned: meta.map(SessionMeta::pinned).unwrap_or(false),
                        pinned_at: meta.and_then(|meta| meta.pinned_at().map(str::to_string)),
                        updated: meta.and_then(|meta| meta.updated().map(str::to_string)),
                        archived: meta.map(SessionMeta::archived).unwrap_or(false),
                    }
                })
                .filter(|one| match context.archived {
                    ArchivedFilter::Show => true,
                    ArchivedFilter::Only => one.archived,
                    ArchivedFilter::Hide => !one.archived,
                })
                .collect();

            flagged.sort_by(|left, right| {
                if left.pinned != right.pinned {
                    return if left.pinned {
                        std::cmp::Ordering::Less
                    } else {
                        std::cmp::Ordering::Greater
                    };
                }
                // Among pinned sessions the most recently pinned comes first.
                match (&left.pinned_at, &right.pinned_at) {
                    (Some(left_at), Some(right_at)) if left_at != right_at => {
                        return right_at.cmp(left_at);
                    }
                    (Some(_), None) => return std::cmp::Ordering::Less,
                    (None, Some(_)) => return std::cmp::Ordering::Greater,
                    _ => {}
                }
                // Otherwise last updated first.
                let left_updated = left.updated.clone().or_else(|| {
                    left.definition
                        .as_ref()
                        .and_then(|d| d.created_at().map(str::to_string))
                });
                let right_updated = right.updated.clone().or_else(|| {
                    right
                        .definition
                        .as_ref()
                        .and_then(|d| d.created_at().map(str::to_string))
                });
                match (left_updated, right_updated) {
                    (Some(left_at), Some(right_at)) if left_at != right_at => {
                        return right_at.cmp(&left_at);
                    }
                    _ => {}
                }
                // Then the clock name descending, which is the newest first.
                compare_names(&right.name, &left.name)
            });

            for one in flagged {
                let mut node = row(context, &one.dir, NodeKind::Session, &one.name, false);
                // A session is a **leaf**: what a person wants is the conversation, not the folder's files.
                node.session = session_of(&one.dir, context);
                node.pinned = one.pinned;
                node.pinned_at = one.pinned_at;
                node.archived = one.archived;
                node.children = Some(Vec::new());
                sessions.push(node);
            }
            continue;
        }

        if !entry.directory {
            let mut node = row(context, &path, NodeKind::File, &entry.name, false);
            node.children = Some(Vec::new());
            node.bytes = Some(entry.bytes);
            rest.push(node);
            continue;
        }

        if let Some(root) = context.by_path.get(&path) {
            rest.push(row(context, &path, NodeKind::Workspace, &root.title, false));
            continue;
        }

        let node_kind = if parent_is_sessions {
            NodeKind::Session
        } else {
            classify(&entry.name, kind, &context.generated)
        };
        let suppress = context
            .sessions
            .get(&path)
            .map(|own| captured_in(&path).contains(own.id()))
            .unwrap_or(false);
        rest.push(row(context, &path, node_kind, &entry.name, suppress));
    }

    sessions.extend(rest);
    sessions
}

/// What a path is, classified segment by segment from the nearest root above it. A path that is not a
/// directory is a `file`; a registered root is a `workspace`; a path under no root is a `folder`; the
/// segment after `_sessions_` is a `session`, and `_sessions_` itself, asked for directly, is a `type`.
pub fn kind_of(path: &str, input: &TreeInput) -> NodeKind {
    let canonical = canonical(path);
    if !is_directory(&canonical) {
        return NodeKind::File;
    }
    let context = Context::build(input);
    if context.by_path.contains_key(&canonical) {
        return NodeKind::Workspace;
    }
    let Some(owner) = context.owner_of(&canonical) else {
        return NodeKind::Folder;
    };
    let relative: Vec<String> = canonical[owner.path.len()..]
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect();
    let mut kind = NodeKind::Workspace;
    let mut in_sessions = false;
    for segment in relative {
        // Past `_sessions_` the next segment is a **session** rather than an instance of a type.
        if segment == SESSIONS_FOLDER {
            in_sessions = true;
            continue;
        }
        if in_sessions {
            kind = NodeKind::Session;
            in_sessions = false;
            continue;
        }
        kind = classify(&segment, kind, &context.generated);
    }
    // The path *is* the sessions folder: it is a type folder, and asking for it lists its sessions.
    if in_sessions { NodeKind::Type } else { kind }
}

/// One level of the tree: the virtual root when `path` is `None` or empty, otherwise that path's node
/// with its direct children (a file's own row when the path is not a directory). A folder asked for
/// that cannot be read is [`WorkspaceError::Unreadable`] (#106); on the virtual root such a root lists
/// with `children: null`.
pub fn tree(path: Option<&str>, input: &TreeInput) -> Result<TreeNode, WorkspaceError> {
    let context = Context::build(input);

    if path.is_none() || path == Some("") {
        let tops: Vec<&TreeRoot> = context
            .roots
            .iter()
            .filter(|root| context.owner_of(&root.path).is_none())
            .collect();
        let as_node = |root: &TreeRoot| -> TreeNode {
            let mut node = row(
                &context,
                &root.path,
                NodeKind::Workspace,
                &root.title,
                false,
            );
            // A root that cannot be read is still listed, with its children **not listed** (`null`)
            // rather than an empty list (#106): asking for it by path answers why.
            node.children = asked_entries(&root.path, &context)
                .ok()
                .map(|listing| children_of(&root.path, NodeKind::Workspace, &context, listing));
            node
        };
        let children = tops
            .iter()
            .filter(|root| root.origin != Some(WorkspaceOrigin::Auto))
            .map(|root| as_node(root))
            .collect();
        let ad_hoc = tops
            .iter()
            .filter(|root| root.origin == Some(WorkspaceOrigin::Auto))
            .map(|root| as_node(root))
            .collect();
        return Ok(TreeNode {
            path: String::new(),
            kind: NodeKind::Roots,
            label: "workspaces".to_string(),
            badge: None,
            session: None,
            pinned: false,
            pinned_at: None,
            archived: false,
            children: Some(children),
            bytes: None,
            ad_hoc: Some(ad_hoc),
        });
    }

    let canonical = canonical(path.unwrap_or_default());
    if !is_directory(&canonical) {
        // Asking for a file answers with the file's own row, so a client that navigates by path never
        // gets a folder-shaped node for something that cannot hold children.
        let mut node = row(
            &context,
            &canonical,
            NodeKind::File,
            &basename(&canonical),
            false,
        );
        node.children = Some(Vec::new());
        node.bytes = Some(size_of(&canonical));
        return Ok(node);
    }
    let (kind, label) = match context.by_path.get(&canonical) {
        Some(root) => (NodeKind::Workspace, root.title.clone()),
        None => (kind_of(&canonical, input), basename(&canonical)),
    };
    let mut node = row(&context, &canonical, kind, &label, false);
    let listing = asked_entries(&canonical, &context)?;
    node.children = Some(children_of(&canonical, kind, &context, listing));
    Ok(node)
}

#[cfg(test)]
mod tests {
    use super::*;
    use heddle_session::definition::{DefinitionOptions, write_session_definition};
    use heddle_session::event::SessionHandle;
    use serde_json::{Value, json};
    use std::path::Path as StdPath;

    fn write(root: &StdPath, relative: &str, text: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    fn meta(id: &str, cwd: &str, created: &str, extra: Value) -> SessionMeta {
        let mut object = json!({
            "id": id,
            "created": created,
            "cwd": cwd,
            "turns": 1,
        });
        if let (Some(object), Some(extra)) = (object.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
        SessionMeta::from_value(object).unwrap()
    }

    fn handle(id: &str, dir: &StdPath) -> SessionHandle {
        SessionHandle {
            id: id.to_string(),
            dir: dir.to_string_lossy().into_owned(),
            transcript: dir
                .join(format!("{id}.v2.jsonl.zstd"))
                .to_string_lossy()
                .into_owned(),
            meta: dir
                .join(format!("{id}.json"))
                .to_string_lossy()
                .into_owned(),
        }
    }

    /// A fixture shaped like a conventions repository, as the verifier builds one.
    fn fixture(root: &StdPath) {
        write(root, "AGENTS.md", "# entry point of the root\n");
        write(root, "README.md", "# read me\n");
        for name in ["_tools_", "_verifiers_", "_monitors_", "_projects_"] {
            write(root, &format!("{name}/INDEX.md"), "# a type\n");
        }
        std::fs::create_dir_all(root.join("_formatters_")).unwrap();
        write(root, "_tools_/some-tool/INDEX.md", "# some-tool\n");
        write(root, "_tools_/some-tool/run.py", "print(\"hi\")\n");
        write(
            root,
            "_verifiers_/05-config-system/INDEX.md",
            "# the claim\n",
        );
        write(root, "_projects_/a-project/INDEX.md", "# a-project\n");
        write(
            root,
            "_projects_/a-project/_context_/INDEX.md",
            "# gathered\n",
        );
        write(root, "shared/INDEX.md", "# shared\n");
        write(root, "shared/_skills_/a-skill/INDEX.md", "# a skill\n");
        write(root, "dist/index.html", "<!doctype html>\n");
        write(root, "node_modules/left-pad/package.json", "{}\n");
        write(root, ".git/HEAD", "ref: refs/heads/main\n");
    }

    fn input(root: &StdPath, sessions: Vec<SessionMeta>) -> TreeInput {
        TreeInput {
            roots: vec![TreeRoot {
                path: root.to_string_lossy().into_owned(),
                title: "root".to_string(),
                origin: Some(WorkspaceOrigin::Added),
            }],
            sessions,
            generated: vec!["dist".to_string()],
            archived: ArchivedFilter::Hide,
        }
    }

    fn child<'a>(node: &'a TreeNode, label: &str) -> Option<&'a TreeNode> {
        node.children
            .as_ref()?
            .iter()
            .find(|child| child.label == label)
    }

    #[test]
    fn badges_are_the_names_people_use() {
        for (name, badge) in [
            ("_tools_", "TLS"),
            ("_verifiers_", "VRF"),
            ("_monitors_", "MNT"),
            ("_formatters_", "FRM"),
            ("_context_", "CTX"),
            ("_conventions_", "CNV"),
            ("_constitutions_", "CNS"),
            ("_web_", "WEB"),
        ] {
            assert_eq!(badge_for(name), badge, "{name}");
        }
    }

    #[test]
    fn a_type_folder_is_a_type_an_instance_is_an_instance_and_a_plain_folder_is_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let input = input(dir.path(), vec![]);
        let root = tree(None, &input).unwrap();
        let workspace = &root.children.as_ref().unwrap()[0];
        assert_eq!(child(workspace, "_tools_").unwrap().kind, NodeKind::Type);
        assert_eq!(
            child(workspace, "_tools_").unwrap().badge.as_deref(),
            Some("TLS")
        );
        assert_eq!(child(workspace, "shared").unwrap().kind, NodeKind::Folder);
        assert_eq!(child(workspace, "dist").unwrap().kind, NodeKind::Generated);
        assert!(child(workspace, ".git").is_none());
        assert!(child(workspace, "node_modules").is_none());
        assert!(child(workspace, "some-tool").is_none(), "one level only");

        let tools = tree(Some(&dir.path().join("_tools_").to_string_lossy()), &input).unwrap();
        assert_eq!(tools.kind, NodeKind::Type);
        assert_eq!(child(&tools, "some-tool").unwrap().kind, NodeKind::Instance);
        assert_eq!(child(&tools, "some-tool").unwrap().badge, None);
        assert_eq!(child(&tools, "INDEX.md").unwrap().kind, NodeKind::File);
    }

    #[test]
    fn folders_come_before_files_and_a_file_is_a_leaf_with_its_size() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let root = tree(
            Some(dir.path().to_str().unwrap()),
            &input(dir.path(), vec![]),
        )
        .unwrap();
        let children = root.children.unwrap();
        let first_file = children
            .iter()
            .position(|node| node.kind == NodeKind::File)
            .expect("the level lists files");
        let last_folder = children
            .iter()
            .rposition(|node| node.kind != NodeKind::File)
            .expect("the level lists folders");
        assert!(first_file > last_folder, "folders stay together at the top");
        let readme = children
            .iter()
            .find(|node| node.label == "README.md")
            .unwrap();
        assert_eq!(readme.children, Some(Vec::new()), "asked and empty");
        assert!(readme.bytes.unwrap() > 0);
    }

    #[test]
    fn a_type_inside_an_instance_is_a_type_again_and_an_empty_type_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let input = input(dir.path(), vec![]);
        let project = dir.path().join("_projects_/a-project");
        let node = tree(Some(project.to_str().unwrap()), &input).unwrap();
        let context = child(&node, "_context_").expect("the type is listed");
        assert_eq!(context.kind, NodeKind::Type);
        assert_eq!(context.badge.as_deref(), Some("CTX"));

        let empty = tree(
            Some(&dir.path().join("_formatters_").to_string_lossy()),
            &input,
        )
        .unwrap();
        assert_eq!(empty.kind, NodeKind::Type);
        assert_eq!(empty.children, Some(Vec::new()));
    }

    #[test]
    fn only_an_instance_carries_a_session_and_a_captured_one_is_not_shown_twice() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let work = dir.path().to_str().unwrap();
        let instance = dir.path().join("_tools_/some-tool");
        let instance_path = instance.to_str().unwrap().to_string();
        let shared = dir.path().join("shared");
        let sessions = vec![
            meta("session-root", work, "2026-10-22T10:00:00.000Z", json!({})),
            meta(
                "session-shared",
                shared.to_str().unwrap(),
                "2026-10-22T11:00:00.000Z",
                json!({}),
            ),
            meta(
                "session-instance",
                &instance_path,
                "2026-10-22T12:00:00.000Z",
                json!({}),
            ),
        ];
        let root = tree(Some(work), &input(dir.path(), sessions.clone())).unwrap();
        assert_eq!(
            root.session, None,
            "the root is a boundary, not an instance"
        );
        assert_eq!(child(&root, "shared").unwrap().session, None);

        let tools = tree(
            Some(&dir.path().join("_tools_").to_string_lossy()),
            &input(dir.path(), sessions.clone()),
        )
        .unwrap();
        let tool = child(&tools, "some-tool").unwrap();
        assert_eq!(tool.kind, NodeKind::Instance);
        let session = tool
            .session
            .as_ref()
            .expect("the instance carries its session");
        assert_eq!(session.id, "session-instance");
        assert_eq!(session.turns, 1);

        // A definition under the instance's own `_sessions_` names the same conversation: the
        // instance's own binding is then suppressed, so one conversation is not shown twice.
        let sessions_folder = instance.join(SESSIONS_FOLDER);
        std::fs::create_dir_all(&sessions_folder).unwrap();
        write_session_definition(
            &handle("session-instance", &dir.path().join("--work--")),
            &instance_path,
            &DefinitionOptions {
                created_at: "2026-10-22T12:00:00.000Z".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let tools = tree(
            Some(&dir.path().join("_tools_").to_string_lossy()),
            &input(dir.path(), sessions),
        )
        .unwrap();
        assert_eq!(child(&tools, "some-tool").unwrap().session, None);
    }

    #[test]
    fn a_branch_shows_its_sessions_first_pinned_before_newest_and_never_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let instance = dir.path().join("_tools_/some-tool");
        let instance_path = instance.to_str().unwrap().to_string();
        let work = dir.path().to_str().unwrap();
        let store_dir = dir.path().join("--work--");
        std::fs::create_dir_all(&store_dir).unwrap();

        let mut names: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
        for (id, created) in [
            ("session-old", "2026-10-22T09:00:00.000Z"),
            ("session-new", "2026-10-22T10:00:00.000Z"),
            ("session-pinned", "2026-10-22T08:00:00.000Z"),
        ] {
            let definition = write_session_definition(
                &handle(id, &store_dir),
                &instance_path,
                &DefinitionOptions {
                    created_at: created.to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            names.insert(id, definition.name);
        }
        let sessions = vec![
            meta("session-old", work, "2026-10-22T09:00:00.000Z", json!({})),
            meta("session-new", work, "2026-10-22T10:00:00.000Z", json!({})),
            meta(
                "session-pinned",
                work,
                "2026-10-22T08:00:00.000Z",
                json!({"pinned": true, "pinnedAt": "2026-10-22T13:00:00.000Z", "updated": "2026-10-22T08:30:00.000Z"}),
            ),
            meta(
                "session-new",
                work,
                "2026-10-22T10:00:00.000Z",
                json!({"updated": "2026-10-22T12:00:00.000Z"}),
            ),
        ];
        let tools = tree(
            Some(&dir.path().join("_tools_/some-tool").to_string_lossy()),
            &input(dir.path(), sessions),
        )
        .unwrap();
        let labels: Vec<String> = tools
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|node| {
                format!(
                    "{}:{}",
                    format!("{:?}", node.kind).to_lowercase(),
                    node.label
                )
            })
            .collect();
        assert_eq!(
            labels[..3],
            [
                format!("session:{}", names["session-pinned"]),
                format!("session:{}", names["session-new"]),
                format!("session:{}", names["session-old"]),
            ],
            "pinned first, then most recently updated, and each named by its folder"
        );
        assert!(!labels.iter().any(|label| label == "type:_sessions_"));
        let pinned = &tools.children.as_ref().unwrap()[0];
        assert!(pinned.pinned);
        assert_eq!(
            pinned.pinned_at.as_deref(),
            Some("2026-10-22T13:00:00.000Z")
        );

        // Asked for by name, the folder is a type and answers with its sessions.
        let asked = tree(
            Some(&instance.join(SESSIONS_FOLDER).to_string_lossy()),
            &input(dir.path(), vec![]),
        )
        .unwrap();
        assert_eq!(asked.kind, NodeKind::Type);
        let answered = asked.children.as_ref().unwrap();
        assert_eq!(
            answered
                .iter()
                .filter(|node| node.kind == NodeKind::Session)
                .count(),
            3,
            "asked for by name, the folder answers with its sessions"
        );
        assert!(
            answered
                .iter()
                .all(|node| node.kind == NodeKind::Session || node.kind == NodeKind::File)
        );
    }

    #[test]
    fn an_archived_session_is_hidden_shown_or_asked_for_alone() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let instance = dir.path().join("_tools_/some-tool");
        let instance_path = instance.to_str().unwrap().to_string();
        let store_dir = dir.path().join("--work--");
        std::fs::create_dir_all(&store_dir).unwrap();
        write_session_definition(
            &handle("session-archived", &store_dir),
            &instance_path,
            &DefinitionOptions {
                created_at: "2026-10-22T09:00:00.000Z".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let sessions = vec![meta(
            "session-archived",
            dir.path().to_str().unwrap(),
            "2026-10-22T09:00:00.000Z",
            json!({"archived": true}),
        )];
        let type_path = dir
            .path()
            .join("_tools_/some-tool")
            .to_string_lossy()
            .into_owned();
        let hidden = tree(Some(&type_path), &input(dir.path(), sessions.clone())).unwrap();
        assert!(
            !hidden
                .children
                .as_ref()
                .unwrap()
                .iter()
                .any(|node| node.kind == NodeKind::Session)
        );

        let mut shown_input = input(dir.path(), sessions.clone());
        shown_input.archived = ArchivedFilter::Show;
        let shown = tree(Some(&type_path), &shown_input).unwrap();
        let archived = shown
            .children
            .as_ref()
            .unwrap()
            .iter()
            .find(|node| node.kind == NodeKind::Session)
            .expect("shown");
        assert!(archived.archived);
    }

    #[test]
    fn the_virtual_root_lists_registered_roots_and_adopted_ones_as_ad_hoc() {
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one");
        let two = dir.path().join("two");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        let input = TreeInput {
            roots: vec![
                TreeRoot {
                    path: one.to_string_lossy().into_owned(),
                    title: "one".to_string(),
                    origin: Some(WorkspaceOrigin::Added),
                },
                TreeRoot {
                    path: two.to_string_lossy().into_owned(),
                    title: "two".to_string(),
                    origin: Some(WorkspaceOrigin::Auto),
                },
            ],
            ..Default::default()
        };
        let root = tree(None, &input).unwrap();
        assert_eq!(root.kind, NodeKind::Roots);
        assert_eq!(root.label, "workspaces");
        assert_eq!(root.children.as_ref().unwrap().len(), 1);
        assert_eq!(root.children.as_ref().unwrap()[0].label, "one");
        assert_eq!(root.ad_hoc.as_ref().unwrap().len(), 1);
        assert_eq!(root.ad_hoc.as_ref().unwrap()[0].label, "two");
        assert_eq!(root.session, None, "the virtual root names no session");
    }

    #[test]
    fn a_path_outside_every_root_is_a_plain_folder_and_a_file_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let input = TreeInput {
            roots: vec![TreeRoot {
                path: dir.path().to_string_lossy().into_owned(),
                title: "root".to_string(),
                origin: Some(WorkspaceOrigin::Added),
            }],
            ..Default::default()
        };
        assert_eq!(
            kind_of(outside.path().to_str().unwrap(), &input),
            NodeKind::Folder
        );
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "hello").unwrap();
        assert_eq!(kind_of(file.to_str().unwrap(), &input), NodeKind::File);
        let node = tree(Some(file.to_str().unwrap()), &input).unwrap();
        assert_eq!(node.kind, NodeKind::File);
        assert_eq!(node.children, Some(Vec::new()));
        assert_eq!(node.bytes, Some(5));
    }

    #[test]
    fn a_node_serializes_in_the_typescript_key_order() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let root = tree(
            Some(dir.path().to_str().unwrap()),
            &input(dir.path(), vec![]),
        )
        .unwrap();
        let value: Value = serde_json::to_value(&root).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(
            object.keys().collect::<Vec<_>>(),
            vec!["path", "kind", "label", "badge", "session", "children"]
        );
        // A file row carries `bytes` after `children` and no `pinned`/`archived`.
        let file = object["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["kind"] == "file")
            .unwrap();
        assert_eq!(
            file.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec![
                "path", "kind", "label", "badge", "session", "children", "bytes"
            ]
        );
        // A session row carries its flags between `session` and `children`.
        let type_dir = dir.path().join("_tools_/some-tool");
        let store_dir = dir.path().join("--work--");
        std::fs::create_dir_all(&store_dir).unwrap();
        write_session_definition(
            &handle("session-1", &store_dir),
            type_dir.to_str().unwrap(),
            &DefinitionOptions {
                created_at: "2026-10-22T09:00:00.000Z".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let sessions = vec![meta(
            "session-1",
            dir.path().to_str().unwrap(),
            "2026-10-22T09:00:00.000Z",
            json!({"pinned": true, "pinnedAt": "2026-10-22T10:00:00.000Z"}),
        )];
        let tools = tree(
            Some(&dir.path().join("_tools_/some-tool").to_string_lossy()),
            &input(dir.path(), sessions),
        )
        .unwrap();
        let session = tools
            .children
            .as_ref()
            .unwrap()
            .iter()
            .find(|node| node.kind == NodeKind::Session)
            .unwrap();
        let value: Value = serde_json::to_value(session).unwrap();
        assert_eq!(
            value.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec![
                "path", "kind", "label", "badge", "session", "pinned", "pinnedAt", "children"
            ]
        );
    }

    #[test]
    fn a_type_folder_name_needs_two_underscores_and_an_instance_two_words() {
        let generated = HashSet::new();
        assert_eq!(
            classify("_tools_", NodeKind::Workspace, &generated),
            NodeKind::Type
        );
        assert_eq!(
            classify("_sessions_", NodeKind::Workspace, &generated),
            NodeKind::Type
        );
        assert_eq!(
            classify("_tools", NodeKind::Workspace, &generated),
            NodeKind::Folder
        );
        assert_eq!(
            classify("some-tool", NodeKind::Type, &generated),
            NodeKind::Instance
        );
        assert_eq!(
            classify("some", NodeKind::Type, &generated),
            NodeKind::Folder
        );
        assert_eq!(
            classify("Some-Tool", NodeKind::Type, &generated),
            NodeKind::Folder
        );
        assert_eq!(
            classify("a-b-c-d-e", NodeKind::Type, &generated),
            NodeKind::Folder,
            "five words is not an instance"
        );
    }

    /// File modes do not stop the superuser; a test run as root cannot judge an unreadable folder.
    fn file_modes_apply() -> bool {
        let probe = tempfile::tempdir().unwrap();
        let locked = probe.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        set_mode(&locked, 0o000);
        let applies = std::fs::read_dir(&locked).is_err();
        set_mode(&locked, 0o755);
        applies
    }

    fn set_mode(path: &StdPath, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// Restores a folder's mode when the test ends, pass or fail, so the temp dir can be removed.
    struct Restore(std::path::PathBuf);

    impl Drop for Restore {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    /// Issue #106: DSH's tree tells an empty level from a failed one (dsh-client-ui-sidebar-files
    /// lib/client.js:483-489), and its backend says `cannot list "<path>": permission denied` of a folder it
    /// may not read (dsh-fs-local lib/index.js:269). This tree answered `[]`, which the page drew as
    /// "nothing inside".
    #[test]
    fn an_unreadable_folder_is_a_failure_with_a_code_not_an_empty_list() {
        if !file_modes_apply() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "locked/held.txt", "a file the tree cannot list\n");
        std::fs::create_dir_all(root.join("empty")).unwrap();
        let input = input(root, vec![]);
        let locked = root.join("locked");
        let _restore = Restore(locked.clone());
        set_mode(&locked, 0o000);

        let error = tree(Some(&locked.to_string_lossy()), &input).unwrap_err();
        assert_eq!(error.code(), Some("workspace-file/unreadable"));
        assert_eq!(
            error.to_string(),
            "cannot list \"locked\": permission denied",
            "named relative to its workspace"
        );

        let empty = tree(Some(&root.join("empty").to_string_lossy()), &input).unwrap();
        assert_eq!(
            empty.children,
            Some(Vec::new()),
            "an empty folder is still asked and empty"
        );
        let parent = tree(Some(&root.to_string_lossy()), &input).unwrap();
        assert!(
            child(&parent, "locked").is_some(),
            "the readable folder above still names it"
        );
    }

    #[test]
    fn an_unreadable_root_is_a_failure_named_by_its_title_and_the_roots_leave_it_unlisted() {
        if !file_modes_apply() {
            return;
        }
        let locked = tempfile::tempdir().unwrap();
        let open = tempfile::tempdir().unwrap();
        write(locked.path(), "held.txt", "inside\n");
        write(open.path(), "kept.txt", "inside\n");
        let root_of = |path: &StdPath, title: &str| TreeRoot {
            path: path.to_string_lossy().into_owned(),
            title: title.to_string(),
            origin: Some(WorkspaceOrigin::Added),
        };
        let input = TreeInput {
            roots: vec![
                root_of(locked.path(), "locked-work"),
                root_of(open.path(), "open-work"),
            ],
            ..TreeInput::default()
        };
        let _restore = Restore(locked.path().to_path_buf());
        set_mode(locked.path(), 0o000);

        let error = tree(Some(&locked.path().to_string_lossy()), &input).unwrap_err();
        assert_eq!(error.code(), Some("workspace-file/unreadable"));
        assert_eq!(
            error.to_string(),
            "cannot list \"locked-work\": permission denied"
        );

        let listing = tree(None, &input).unwrap();
        let roots = listing.children.unwrap();
        let canonical_of = |path: &StdPath| canonical(&path.to_string_lossy());
        let unlisted = roots
            .iter()
            .find(|node| node.path == canonical_of(locked.path()))
            .unwrap();
        assert_eq!(
            unlisted.children, None,
            "not asked-and-empty: the listing could not ask"
        );
        let listed = roots
            .iter()
            .find(|node| node.path == canonical_of(open.path()))
            .unwrap();
        assert_eq!(
            listed.children.as_ref().map(Vec::len),
            Some(1),
            "a readable root beside it lists"
        );
    }
}
