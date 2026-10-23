//! The seam between the file routes and the rest of the harness: what [`crate::routes`] needs from its host.
//!
//! The server implements [`FilesHost`] over the crates that own each answer — the home from the configuration, the
//! workspace roots from the workspace crate, the file reading from the session tree — and hands it to
//! [`crate::routes::FilesRoutes::new`]. Until those crates exist, this crate's tests use a double, and so can the
//! server's.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Whether a path is inside a registered workspace root — `ctx.workspace?.owner(path)` in `src/server/web.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceAnswer {
    /// The profile does not load the workspace plugin: `GET /api/file` answers `503`, `/api/raw` and `/api/html`
    /// answer `404`.
    NotLoaded,
    /// No registered root contains the path.
    Outside,
    /// A registered root contains the path.
    Owned,
}

/// One file's text, as `readFileText` of `src/session/tree.ts` answers it, and as the first half of the
/// `GET /api/file` body: `{"path","name","bytes","lines","text","truncated"}`, in that order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileReading {
    /// The canonical path that was read.
    pub path: String,
    /// Its leaf.
    pub name: String,
    /// The size of the whole file, which may exceed `text` when `truncated`.
    pub bytes: u64,
    /// Newline-separated lines in `text`, a final newline not opening another (0 for an empty file).
    pub lines: u64,
    /// The text, up to the reader's limit (256 KiB in the TypeScript build).
    pub text: String,
    pub truncated: bool,
}

/// Why a file has no text to show. The route maps each to a status and answers `{"error": <message>}`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FileReadError {
    /// `<canonical> is not a file` — answered `404`.
    #[error("{0}")]
    NotAFile(String),
    /// `<canonical> looks like a binary file, so it has no text to show`, or `<canonical> is not UTF-8 text, so it
    /// has no text to show` — answered `415`.
    #[error("{0}")]
    NotText(String),
}

/// What the file routes need from the harness they are mounted in.
pub trait FilesHost: Send + Sync + 'static {
    /// `$HEDDLE_HOME`; uploads are stored in, and attachments and `/api/uploads/{leaf}` are confined to,
    /// `<home>/uploads`.
    fn heddle_home(&self) -> PathBuf;

    /// Whether `path` (absolute, as the request named it) is inside a registered workspace root. The host compares
    /// the **canonical** path, so a symlink that resolves outside every root is [`WorkspaceAnswer::Outside`].
    fn workspace_owner(&self, path: &Path) -> WorkspaceAnswer;

    /// Read a file's text for the panel — the session tree's `readFileText`.
    fn read_file_text(&self, path: &Path) -> Result<FileReading, FileReadError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_serializes_in_the_order_the_file_route_answers() {
        let reading = FileReading {
            path: "/w/a.py".into(),
            name: "a.py".into(),
            bytes: 4,
            lines: 1,
            text: "x=1\n".into(),
            truncated: false,
        };
        assert_eq!(
            serde_json::to_string(&reading).unwrap(),
            r#"{"path":"/w/a.py","name":"a.py","bytes":4,"lines":1,"text":"x=1\n","truncated":false}"#
        );
    }
}
