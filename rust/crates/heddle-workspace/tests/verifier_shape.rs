//! The shape `_verifiers_/70-workspaces-sessions` judges, exercised across both crates.
//!
//! The verifier drives the `heddle` binary, so it can only judge this pair once the command line
//! composes them. These tests hold the same claims at the API seam the command line will call, so a
//! change that would fail `70` fails here first: one folder holds one session, a workspace accounts for
//! the folders at or below it, a subdirectory is a member of the root above it, a sibling that shares a
//! prefix is not, the tree hoists a branch's sessions and only an instance carries one, and a file under
//! a root reads while a path outside every root has no owner to ask.

use std::path::Path;

use heddle_config::Env;
use heddle_session::{
    CreateAtOptions, OpenAtOptions, SessionConfig, SessionHandle, SessionMeta, SessionService,
};
use heddle_workspace::{
    ArchivedFilter, NodeKind, TreeInput, TreeRoot, WorkspaceConfig, WorkspaceService, kind_of,
    listing_row, read_file_text, tree,
};
use serde_json::json;

/// A store and a workspace record in one temporary home.
struct Harness {
    home: tempfile::TempDir,
    sessions: SessionService,
    workspaces: WorkspaceService,
}

impl Harness {
    fn new() -> Harness {
        let home = tempfile::tempdir().unwrap();
        let env = Env::default();
        let sessions = SessionService::new(
            &SessionConfig {
                root: Some(home.path().join("sessions").to_string_lossy().into_owned()),
            },
            &env,
            None,
        );
        let workspaces = WorkspaceService::new(
            &WorkspaceConfig {
                file: Some(
                    home.path()
                        .join("workspaces.json")
                        .to_string_lossy()
                        .into_owned(),
                ),
                generated: vec!["dist".to_string()],
            },
            &env,
        );
        Harness {
            home,
            sessions,
            workspaces,
        }
    }

    fn sessions(&self) -> Vec<SessionMeta> {
        self.sessions.list()
    }

    fn input(&self) -> TreeInput {
        TreeInput {
            roots: self.workspaces.list().iter().map(TreeRoot::from).collect(),
            sessions: self.sessions(),
            generated: self.workspaces.generated().to_vec(),
            archived: ArchivedFilter::Hide,
        }
    }
}

/// A folder for the fixture, created and returned as a string.
fn folder(path: &Path) -> String {
    std::fs::create_dir_all(path).unwrap();
    path.to_string_lossy().into_owned()
}

/// One file under the fixture, with its parents created.
fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

/// A conventions-shaped root, so the tree has types, instances, a plain folder and plumbing to classify.
fn fixture(root: &Path) {
    write(root, "AGENTS.md", "# entry point\n");
    write(root, "_tools_/INDEX.md", "# tools\n");
    write(root, "_tools_/some-tool/INDEX.md", "# some-tool\n");
    write(root, "_tools_/plain-tool/INDEX.md", "# plain-tool\n");
    write(
        root,
        "_verifiers_/05-config-system/INDEX.md",
        "# the claim\n",
    );
    write(root, "shared/INDEX.md", "# shared\n");
    write(root, "dist/index.html", "<!doctype html>\n");
    write(root, "node_modules/left-pad/package.json", "{}\n");
}

/// Pin a session's `created` so "newest first" is decided by the test rather than by the clock.
fn stamp(handle: &SessionHandle, created: &str) {
    let text = std::fs::read_to_string(&handle.meta).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let mut meta = SessionMeta::from_value(value).unwrap();
    meta.set("created", json!(created));
    std::fs::write(&handle.meta, meta.to_file_text()).unwrap();
}

fn child<'a>(
    node: &'a heddle_workspace::TreeNode,
    label: &str,
) -> Option<&'a heddle_workspace::TreeNode> {
    node.children
        .as_ref()?
        .iter()
        .find(|child| child.label == label)
}

#[test]
fn one_folder_holds_one_session_and_new_starts_another() {
    let h = Harness::new();
    let work_path = h.home.path().join("work");
    let work = folder(&work_path);
    fixture(Path::new(&work));
    // An **instance** is where a folder's session shows, so the tree half uses one.
    let instance = work_path.join("_tools_/some-tool");
    let instance_path = instance.to_string_lossy().into_owned();
    h.workspaces.add(&work, Some("work")).unwrap();

    let first = h
        .sessions
        .open_at(&instance_path, OpenAtOptions::default())
        .unwrap();
    h.sessions
        .user(&first, "the first conversation", None)
        .unwrap();
    stamp(&first, "2026-10-22T10:00:00.000Z");

    // Asking one folder twice continues one session; the second prompt lands in it.
    let again = h
        .sessions
        .open_at(&instance_path, OpenAtOptions::default())
        .unwrap();
    assert_eq!(again.id, first.id);
    h.sessions
        .user(&again, "the second conversation", None)
        .unwrap();

    // `--new` rotates the folder's pointer without replacing anything on disk.
    let fresh = h
        .sessions
        .open_at(
            &instance_path,
            OpenAtOptions {
                fresh: true,
                ..Default::default()
            },
        )
        .unwrap();
    h.sessions.user(&fresh, "fresh words", None).unwrap();
    stamp(&fresh, "2026-10-22T11:00:00.000Z");
    assert_ne!(fresh.id, first.id);

    let listed = h.sessions();
    assert_eq!(
        listed.len(),
        2,
        "the new session did not replace the old one"
    );
    assert_eq!(
        h.sessions
            .current(&instance_path)
            .map(|meta| meta.id().to_string()),
        Some(fresh.id.clone()),
        "the folder points at its newest session"
    );

    // Both turns are still in the first session, by its id.
    let text_of = |handle: &SessionHandle| -> String {
        h.sessions
            .events(handle)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "message")
            .map(|event| {
                heddle_session::text_of(
                    &serde_json::from_value::<heddle_session::Message>(
                        event.get("message").unwrap().clone(),
                    )
                    .unwrap()
                    .content,
                )
            })
            .collect()
    };
    assert_eq!(
        text_of(&first),
        "the first conversationthe second conversation",
        "both turns stayed in the one session"
    );

    // The tree's instance node is the folder's current session, not its first prompt.
    let node = tree(Some(&instance_path), &h.input());
    assert_eq!(node.kind, NodeKind::Instance);
    assert_eq!(
        node.session.as_ref().map(|session| session.id.as_str()),
        Some(fresh.id.as_str())
    );
    assert_eq!(node.session.as_ref().unwrap().turns, 1);
}

#[test]
fn a_workspace_accounts_for_its_folders_and_the_nearest_root_owns_a_session() {
    let h = Harness::new();
    let work_path = h.home.path().join("work");
    let work = folder(&work_path);
    fixture(Path::new(&work));
    let deeper = folder(&work_path.join("nested").join("deeper"));

    // The root is registered before the turns, as the verifier's fixture does: containment, not equality.
    let root = h.workspaces.add(&work, Some("work")).unwrap().record;

    let in_root = h.sessions.open_at(&work, OpenAtOptions::default()).unwrap();
    stamp(&in_root, "2026-10-22T10:00:00.000Z");
    let in_child = h
        .sessions
        .open_at(&deeper, OpenAtOptions::default())
        .unwrap();
    stamp(&in_child, "2026-10-22T11:00:00.000Z");
    let rotated = h
        .sessions
        .open_at(
            &work,
            OpenAtOptions {
                fresh: true,
                ..Default::default()
            },
        )
        .unwrap();
    stamp(&rotated, "2026-10-22T12:00:00.000Z");

    let all = h.sessions();
    let report = h.workspaces.bootstrap(&all).unwrap();
    assert_eq!(
        report.created, 0,
        "both folders are under the registered root"
    );
    assert_eq!(report.workspaces, 1);

    let record = h.workspaces.find(&work).unwrap();
    assert_eq!(record.id, root.id);
    let owned = h.workspaces.sessions(&record, &all);
    assert_eq!(
        owned.len(),
        3,
        "the subdirectory is a member of the root above"
    );
    assert_eq!(
        owned.iter().map(|meta| meta.id()).collect::<Vec<_>>(),
        vec![
            rotated.id.as_str(),
            in_child.id.as_str(),
            in_root.id.as_str()
        ],
        "the store's newest-first order is kept"
    );

    // `heddle workspaces --json` is `{ ...record, sessions: [ids] }`.
    let row = listing_row(&record, &owned);
    assert_eq!(row["id"], json!(record.id));
    assert_eq!(
        row["path"],
        json!(heddle_config::canonical_path(Path::new(&work)).to_string_lossy())
    );
    assert_eq!(row["title"], json!("work"));
    assert_eq!(
        row["sessions"],
        json!([rotated.id, in_child.id, in_root.id])
    );

    // A sibling whose path shares every character of the root is a workspace of its own.
    let sibling = folder(&h.home.path().join("work-sibling"));
    let sibling_session = h
        .sessions
        .open_at(&sibling, OpenAtOptions::default())
        .unwrap();
    stamp(&sibling_session, "2026-10-22T13:00:00.000Z");
    let all = h.sessions();
    let report = h.workspaces.bootstrap(&all).unwrap();
    assert_eq!(report.created, 1, "the sibling is adopted as its own root");
    assert_eq!(
        h.workspaces
            .sessions(&h.workspaces.find(&work).unwrap(), &all)
            .len(),
        3,
        "the root accounts only for its own"
    );
    let adopted = h.workspaces.find(&sibling).unwrap();
    assert_eq!(
        h.workspaces.sessions(&adopted, &all).len(),
        1,
        "the sibling accounts only for its own"
    );
    assert_eq!(
        h.workspaces.owner(&deeper).map(|record| record.id),
        Some(root.id),
        "the nearest root above a folder owns it"
    );
    let _ = h.home.path();
}

#[test]
fn the_tree_hoists_a_branchs_sessions_and_only_an_instance_carries_one() {
    let h = Harness::new();
    let work_path = h.home.path().join("work");
    let work = folder(&work_path);
    fixture(Path::new(&work));
    h.workspaces.add(&work, Some("work")).unwrap();
    let instance = work_path.join("_tools_/some-tool");
    let plain_instance = work_path.join("_tools_/plain-tool");
    let shared = work_path.join("shared");

    // A turn in a plain instance is carried by the instance; a turn in `shared` is not, because a plain
    // folder is not a place a session shows.
    let carried = h
        .sessions
        .open_at(&plain_instance.to_string_lossy(), OpenAtOptions::default())
        .unwrap();
    stamp(&carried, "2026-10-22T09:00:00.000Z");
    let in_shared = h
        .sessions
        .open_at(&shared.to_string_lossy(), OpenAtOptions::default())
        .unwrap();
    stamp(&in_shared, "2026-10-22T09:30:00.000Z");

    // Two definitions under the instance capture their conversations, so the instance's own binding is
    // suppressed and each conversation is shown once, on its session row.
    let first = h
        .sessions
        .create_at(
            &instance.to_string_lossy(),
            CreateAtOptions {
                title: Some("A first conversation".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
    stamp(&first.handle, "2026-10-22T10:00:00.000Z");
    let second = h
        .sessions
        .create_at(
            &instance.to_string_lossy(),
            CreateAtOptions {
                title: Some("A second conversation".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
    stamp(&second.handle, "2026-10-22T11:00:00.000Z");

    let input = h.input();
    let tools = tree(Some(&work_path.join("_tools_").to_string_lossy()), &input);
    let some_tool = child(&tools, "some-tool").expect("the instance is listed");
    assert_eq!(some_tool.kind, NodeKind::Instance);
    assert_eq!(
        some_tool.session, None,
        "a captured conversation is shown on its session row, not twice"
    );
    let plain = child(&tools, "plain-tool").expect("the carried instance is listed");
    assert_eq!(
        plain.session.as_ref().map(|session| session.id.clone()),
        Some(carried.id.clone()),
        "an instance carries the session started in it"
    );

    let branch = tree(Some(&instance.to_string_lossy()), &input);
    let children = branch.children.as_ref().unwrap();
    let session_rows: Vec<&heddle_workspace::TreeNode> = children
        .iter()
        .filter(|node| node.kind == NodeKind::Session)
        .collect();
    assert_eq!(session_rows.len(), 2, "both definitions are hoisted");
    assert_eq!(
        children[0].kind,
        NodeKind::Session,
        "a branch's sessions come before everything else"
    );
    // Newest first: the definitions are named chronologically, so the later one sorts first.
    assert_eq!(
        session_rows[0].label, second.definition.name,
        "the newest session is the row at the top"
    );
    assert_eq!(session_rows[1].label, first.definition.name);
    assert!(
        children.iter().all(|node| node.label != "_sessions_"),
        "the filing folder is never drawn"
    );
    assert_eq!(
        session_rows[0].session.as_ref().unwrap().id.as_str(),
        second.handle.id.as_str()
    );

    // A type folder and a plain folder carry no session; a file is a leaf; `dist` is declared generated.
    let root = tree(Some(&work), &input);
    assert_eq!(child(&root, "shared").unwrap().session, None);
    assert_eq!(child(&root, "_verifiers_").unwrap().kind, NodeKind::Type);
    let agents = child(&root, "AGENTS.md").unwrap();
    assert_eq!(agents.kind, NodeKind::File);
    assert_eq!(agents.children, Some(Vec::new()));
    assert_eq!(child(&root, "dist").unwrap().kind, NodeKind::Generated);
    assert!(child(&root, "node_modules").is_none());
    let workspaces = tree(None, &input);
    assert_eq!(workspaces.kind, NodeKind::Roots);
    assert_eq!(
        workspaces.children.as_ref().unwrap().len(),
        1,
        "the registered root is a child of the virtual root"
    );
}

#[test]
fn a_file_under_a_root_reads_and_a_path_outside_one_has_no_owner() {
    let h = Harness::new();
    let work_path = h.home.path().join("work");
    let work = folder(&work_path);
    fixture(Path::new(&work));
    h.workspaces.add(&work, Some("work")).unwrap();

    // Inside a root: the page may read it, and the reading carries what a panel shows.
    let read = read_file_text(&work_path.join("shared/INDEX.md").to_string_lossy(), None).unwrap();
    assert_eq!(read.name, "INDEX.md");
    assert!(read.text.contains("# shared"));
    assert!(!read.truncated);
    assert!(read.bytes > 0);

    // Outside every root: the reader works, but the caller has no owner to ask and refuses it.
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), "# not under any root\n").unwrap();
    let outside_file = outside
        .path()
        .join("secret.md")
        .to_string_lossy()
        .into_owned();
    assert!(
        h.workspaces.owner(&outside_file).is_none(),
        "the refusal is the caller's, made on the canonical path"
    );
    assert!(read_file_text(&outside_file, None).is_ok());

    // A folder is not a file, and a binary is not text.
    assert!(
        read_file_text(&work_path.join("shared").to_string_lossy(), None)
            .unwrap_err()
            .to_string()
            .ends_with("is not a file")
    );
    std::fs::write(work_path.join("blob.bin"), [0x00, 0x01, 0x02]).unwrap();
    assert!(
        read_file_text(&work_path.join("blob.bin").to_string_lossy(), None)
            .unwrap_err()
            .to_string()
            .contains("looks like a binary file")
    );

    // A file under a root is a leaf node, while a folder under no root is classified a plain folder.
    let input = h.input();
    let node = tree(Some(&work_path.join("AGENTS.md").to_string_lossy()), &input);
    assert_eq!(node.kind, NodeKind::File);
    assert_eq!(node.bytes, Some(14));
    assert_eq!(
        kind_of(&outside_file, &input),
        NodeKind::File,
        "a path outside every root is still classified, and refusing it is the caller's job"
    );
}
