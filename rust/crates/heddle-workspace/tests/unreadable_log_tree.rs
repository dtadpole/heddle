//! Issue #130 in the folder tree: the definition row of a session whose log cannot be read is left out.
//!
//! The store leaves such a session out of `list()` and opens it as no session (DSH: an unreadable header is "omitted
//! from discovery and `list()`"). Measured after that fix: `GET /api/tree` still drew the session from its definition,
//! `<folder>/_sessions_/<name>/session.json`, and a click on the row got 404. The tree asks the store's own judgement
//! (`heddle_session::read_log_header`) of the log a definition names, for a definition the store does not list; a
//! missing log still draws, as a definition cloned from another machine does. The twin of the tree check in
//! `test/session-unreadable-log.test.ts`.

use std::sync::Arc;

use heddle_config::Env;
use heddle_session::{CreateAtOptions, SessionConfig, SessionService};
use heddle_workspace::{ArchivedFilter, NodeKind, TreeInput, TreeNode, TreeRoot, tree};

/// `tree` answers a node today and a `Result` once #106's refusal of an unreadable folder lands; this check reads the
/// node either way, so the two branches merge without touching it.
trait IntoNode {
    fn into_node(self) -> TreeNode;
}
impl IntoNode for TreeNode {
    fn into_node(self) -> TreeNode {
        self
    }
}
impl<E: std::fmt::Debug> IntoNode for Result<TreeNode, E> {
    fn into_node(self) -> TreeNode {
        self.expect("the folder lists")
    }
}

#[test]
fn the_tree_leaves_out_the_row_of_a_session_whose_log_cannot_be_read_and_draws_one_whose_log_is_missing()
 {
    let home = tempfile::tempdir().unwrap();
    let branch = home.path().join("work");
    std::fs::create_dir_all(&branch).unwrap();
    let branch = std::fs::canonicalize(&branch)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let sessions = SessionService::new(
        &SessionConfig {
            root: Some(home.path().join("sessions").to_string_lossy().into_owned()),
        },
        &Env::default(),
        None,
    );
    sessions.store().set_warn(Arc::new(|_: &str| {}));
    let create = || {
        sessions
            .create_at(&branch, CreateAtOptions::default())
            .unwrap()
            .handle
    };
    let (healthy, missing, damaged) = (create(), create(), create());
    for handle in [&healthy, &missing, &damaged] {
        sessions.store().release(handle);
    }
    std::fs::write(&damaged.transcript, b"{\"not\":\"zstd\"}\n").unwrap();
    std::fs::remove_file(&missing.transcript).unwrap();

    let input = TreeInput {
        roots: vec![TreeRoot {
            path: branch.clone(),
            title: "work".to_string(),
            origin: None,
        }],
        sessions: sessions.list(),
        generated: Vec::new(),
        archived: ArchivedFilter::Hide,
    };
    let rows: Vec<String> = tree(Some(&branch), &input)
        .into_node()
        .children
        .unwrap_or_default()
        .into_iter()
        .filter(|node| node.kind == NodeKind::Session)
        .filter_map(|node| node.session.map(|session| session.id))
        .collect();
    assert!(
        rows.contains(&healthy.id),
        "a healthy session keeps its row: {rows:?}"
    );
    assert!(
        rows.contains(&missing.id),
        "a session whose log is missing still draws: {rows:?}"
    );
    assert!(
        !rows.contains(&damaged.id),
        "the session whose log cannot be read has no row: {rows:?}"
    );
}
