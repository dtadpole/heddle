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
    /// A symlink: its row stays at the link's own path, not its target's.
    link: bool,
}

/// One directory's entries worth showing: folders first, then files, each name-sorted; dot-entries and
/// the two noise directories are not returned at all.
///
/// A **symlink is what it resolves to**, as DSH lists one (`dsh-fs-local` `listDirectory` probes each
/// child's resolved target; `dsh-api-workspace-files` reports a size only for a regular file): a linked
/// folder is a folder, a linked file carries its target's size, and a link that resolves to nothing is a
/// 0-byte leaf. A directory entry's own file type does not follow the link, which is why a link to a
/// folder used to list as a file with the folder entry's size.
fn entries(dir: &str) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<Entry> = read
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            !name.starts_with('.') && !PLUMBING.contains(&name.as_str())
        })
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = Path::new(dir).join(&name).to_string_lossy().into_owned();
            let link = entry
                .file_type()
                .map(|kind| kind.is_symlink())
                .unwrap_or(false);
            if link {
                // `metadata` follows the link; an error is a link that resolves to nothing.
                let target = std::fs::metadata(&path).ok();
                let directory = target
                    .as_ref()
                    .map(|target| target.is_dir())
                    .unwrap_or(false);
                let bytes = target
                    .filter(|target| target.is_file())
                    .map(|target| target.len())
                    .unwrap_or(0);
                return Entry {
                    name,
                    directory,
                    bytes,
                    link,
                };
            }
            let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            Entry {
                name,
                directory,
                bytes: if directory { 0 } else { size_of(&path) },
                link,
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
    entries
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

/// The direct children of a folder: its subfolders, its files, or a registered root among them.
fn children_of(dir: &str, kind: NodeKind, context: &Context) -> Vec<TreeNode> {
    let mut sessions: Vec<TreeNode> = Vec::new();
    let mut rest: Vec<TreeNode> = Vec::new();
    // Asked for **by name**, the sessions folder answers with sessions rather than with instances.
    let parent_is_sessions = basename(dir) == SESSIONS_FOLDER;

    for entry in entries(dir) {
        // A link's row stays at the **link's own path**, DSH's rule (a child's path is the listed
        // directory's joined with its name): canonicalising it put the row at its target's path, which the
        // target's own row already holds. Asking for the link's path lists its target; refusing a link that
        // leads outside every root is the caller's containment check.
        let joined = Path::new(dir)
            .join(&entry.name)
            .to_string_lossy()
            .into_owned();
        let path = if entry.link {
            joined
        } else {
            canonical(&joined)
        };

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
/// with its direct children (a file's own row when the path is not a directory).
pub fn tree(path: Option<&str>, input: &TreeInput) -> TreeNode {
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
            node.children = Some(children_of(&root.path, NodeKind::Workspace, &context));
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
        return TreeNode {
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
        };
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
        return node;
    }
    let (kind, label) = match context.by_path.get(&canonical) {
        Some(root) => (NodeKind::Workspace, root.title.clone()),
        None => (kind_of(&canonical, input), basename(&canonical)),
    };
    let mut node = row(&context, &canonical, kind, &label, false);
    node.children = Some(children_of(&canonical, kind, &context));
    node
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
        let root = tree(None, &input);
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

        let tools = tree(Some(&dir.path().join("_tools_").to_string_lossy()), &input);
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
        );
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
        let node = tree(Some(project.to_str().unwrap()), &input);
        let context = child(&node, "_context_").expect("the type is listed");
        assert_eq!(context.kind, NodeKind::Type);
        assert_eq!(context.badge.as_deref(), Some("CTX"));

        let empty = tree(
            Some(&dir.path().join("_formatters_").to_string_lossy()),
            &input,
        );
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
        let root = tree(Some(work), &input(dir.path(), sessions.clone()));
        assert_eq!(
            root.session, None,
            "the root is a boundary, not an instance"
        );
        assert_eq!(child(&root, "shared").unwrap().session, None);

        let tools = tree(
            Some(&dir.path().join("_tools_").to_string_lossy()),
            &input(dir.path(), sessions.clone()),
        );
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
        );
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
        );
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
        );
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
        let hidden = tree(Some(&type_path), &input(dir.path(), sessions.clone()));
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
        let shown = tree(Some(&type_path), &shown_input);
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
        let root = tree(None, &input);
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
        let node = tree(Some(file.to_str().unwrap()), &input);
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
        );
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
        );
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

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_folder_lists_as_a_folder_at_its_own_path_and_expands_to_its_target() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("nest/inner")).unwrap();
        std::fs::create_dir_all(outside.path().join("far")).unwrap();
        write(root, "nest/a.txt", "hello\n");
        write(root, "plain.txt", "x\n");
        symlink("nest", root.join("nest-link")).unwrap();
        symlink("plain.txt", root.join("file-link")).unwrap();
        symlink("missing", root.join("dangling")).unwrap();
        symlink(outside.path().join("far"), root.join("out-link")).unwrap();
        let canonical_root = canonical(root.to_str().unwrap());
        let at = |name: &str| format!("{canonical_root}/{name}");
        let input = TreeInput {
            roots: vec![TreeRoot {
                path: root.to_string_lossy().into_owned(),
                title: "root".to_string(),
                origin: Some(WorkspaceOrigin::Added),
            }],
            ..Default::default()
        };
        let level = tree(Some(root.to_str().unwrap()), &input);

        let link = child(&level, "nest-link").expect("the link is listed");
        assert_eq!(
            link.kind,
            NodeKind::Folder,
            "a link to a folder is a folder row"
        );
        assert_eq!(link.children, None, "which can be expanded");
        assert_eq!(link.bytes, None, "and carries no size");
        assert_eq!(link.path, at("nest-link"), "at its own path");
        assert_eq!(child(&level, "nest").unwrap().path, at("nest"));
        let paths: HashSet<&str> = level
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|node| node.path.as_str())
            .collect();
        assert_eq!(
            paths.len(),
            level.children.as_ref().unwrap().len(),
            "no two rows share one path"
        );

        let out = child(&level, "out-link").unwrap();
        assert_eq!(
            out.kind,
            NodeKind::Folder,
            "a link leading outside still lists as a folder"
        );
        assert_eq!(out.path, at("out-link"));

        let file_link = child(&level, "file-link").unwrap();
        assert_eq!(file_link.kind, NodeKind::File);
        assert_eq!(file_link.bytes, Some(2), "with its target's size");
        assert_eq!(file_link.path, at("file-link"));

        let dangling = child(&level, "dangling").unwrap();
        assert_eq!(dangling.kind, NodeKind::File, "a link to nothing is a leaf");
        assert_eq!(dangling.bytes, Some(0));

        let labels: Vec<&str> = level
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|node| node.label.as_str())
            .collect();
        assert_eq!(
            labels,
            vec![
                "nest",
                "nest-link",
                "out-link",
                "dangling",
                "file-link",
                "plain.txt"
            ],
            "a linked folder sorts with the folders"
        );

        let expanded = tree(Some(&at("nest-link")), &input);
        let inside: Vec<String> = expanded
            .children
            .unwrap()
            .iter()
            .map(|node| format!("{:?}:{}", node.kind, node.label))
            .collect();
        assert_eq!(
            inside,
            vec!["Folder:inner", "File:a.txt"],
            "expanding the link lists its target"
        );
    }
}
