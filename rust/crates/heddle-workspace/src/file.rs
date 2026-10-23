//! Reading a text file for the right panel, refusing what a viewer cannot show.
//!
//! Ported from `readFileText` in `src/session/tree.ts`. Three refusals, each a sentence a person can
//! act on: a directory or a missing path is not a file; a binary (a NUL byte in what is read) is not
//! text; bytes that are not UTF-8 are not text. A file longer than the limit is **truncated and says
//! so** rather than refused. This is a view, not a way around the sandbox: the caller decides which paths
//! are readable (the command line and the server both ask [`crate::WorkspaceService::owner`] first, on
//! the canonical path, so a symlink pointing outside every root is refused).

use serde::Serialize;
use thiserror::Error;

/// How much of a file is handed back unless a caller says otherwise: 256 KiB.
pub const FILE_LIMIT_BYTES: usize = 256 * 1024;

/// A file, as the right panel shows it. Serialized `{ path, name, bytes, lines, text, truncated }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileReading {
    /// The canonical path.
    pub path: String,
    pub name: String,
    /// The whole file's size.
    pub bytes: u64,
    /// Lines in `text`: `\n`-separated, a trailing newline not counting a line of its own; 0 when empty.
    pub lines: usize,
    pub text: String,
    /// The file is longer than the limit, so `text` is its beginning.
    pub truncated: bool,
}

/// Why a file was refused. The messages are the TypeScript build's, and a verifier matches `not a file`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FileReadError {
    /// `<path> is not a file`
    #[error("{0} is not a file")]
    NotAFile(String),
    /// `<path> looks like a binary file, so it has no text to show`
    #[error("{0} looks like a binary file, so it has no text to show")]
    Binary(String),
    /// `<path> is not UTF-8 text, so it has no text to show` — including a file cut by the limit in the
    /// middle of a character, as the TypeScript build refuses it.
    #[error("{0} is not UTF-8 text, so it has no text to show")]
    NotUtf8(String),
}

/// Read a text file for the viewer: at most `limit` bytes ([`FILE_LIMIT_BYTES`] when `None`).
pub fn read_file_text(path: &str, limit: Option<usize>) -> Result<FileReading, FileReadError> {
    todo!()
}
