//! Reading a text file for the right panel, refusing what a viewer cannot show.
//!
//! Ported from `readFileText` in `src/session/tree.ts`. Three refusals, each a sentence a person can
//! act on: a directory or a missing path is not a file; a binary (a NUL byte in what is read) is not
//! text; bytes that are not UTF-8 are not text. A file longer than the limit is **truncated and says
//! so** rather than refused. This is a view, not a way around the sandbox: the caller decides which paths
//! are readable (the command line and the server both ask [`crate::WorkspaceService::owner`] first, on
//! the canonical path, so a symlink pointing outside every root is refused).

use std::path::Path;

use heddle_config::canonical_path;
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
    let canonical = canonical_path(Path::new(path))
        .to_string_lossy()
        .into_owned();
    let Ok(metadata) = std::fs::metadata(&canonical) else {
        return Err(FileReadError::NotAFile(canonical));
    };
    if !metadata.is_file() {
        return Err(FileReadError::NotAFile(canonical));
    }
    let Ok(whole) = std::fs::read(&canonical) else {
        return Err(FileReadError::NotAFile(canonical));
    };
    let limit = limit.unwrap_or(FILE_LIMIT_BYTES);
    let slice = &whole[..limit.min(whole.len())];
    if slice.contains(&0) {
        return Err(FileReadError::Binary(canonical));
    }
    // `buffer.toString('utf8')` replaces every byte sequence that is not UTF-8 with U+FFFD, and the
    // TypeScript build then refuses a file whose text carries one — including one the limit cut in the
    // middle of a character.
    let text = String::from_utf8_lossy(slice).into_owned();
    if text.contains('\u{FFFD}') {
        return Err(FileReadError::NotUtf8(canonical));
    }
    let lines = if text.is_empty() {
        0
    } else {
        let newlines = text.matches('\n').count();
        newlines + usize::from(!text.ends_with('\n'))
    };
    let name = Path::new(&canonical)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical.clone());
    Ok(FileReading {
        path: canonical,
        name,
        bytes: whole.len() as u64,
        lines,
        text,
        truncated: whole.len() > slice.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn a_small_file_is_whole_and_counts_its_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "INDEX.md", b"# a\n\nb\n");
        let reading = read_file_text(&path, None).unwrap();
        assert_eq!(reading.name, "INDEX.md");
        assert_eq!(reading.text, "# a\n\nb\n");
        assert_eq!(reading.lines, 3);
        assert_eq!(reading.bytes, 7);
        assert!(!reading.truncated);
    }

    #[test]
    fn a_file_without_a_trailing_newline_counts_its_last_line() {
        let dir = tempfile::tempdir().unwrap();
        let reading = read_file_text(&write(&dir, "a.txt", b"one\ntwo"), None).unwrap();
        assert_eq!(reading.lines, 2);
        let empty = read_file_text(&write(&dir, "b.txt", b""), None).unwrap();
        assert_eq!(empty.lines, 0);
        assert_eq!(empty.text, "");
    }

    #[test]
    fn a_file_longer_than_the_limit_is_truncated_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "big.txt", "line\n".repeat(10).as_bytes());
        let reading = read_file_text(&path, Some(5)).unwrap();
        assert_eq!(reading.text, "line\n");
        assert!(reading.truncated);
        assert_eq!(reading.bytes, 50, "the size is the whole file's");
    }

    #[test]
    fn a_binary_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.bin", b"ab\0cd");
        let error = read_file_text(&path, None).unwrap_err();
        assert!(matches!(error, FileReadError::Binary(_)));
        assert!(
            error
                .to_string()
                .ends_with("looks like a binary file, so it has no text to show")
        );
    }

    #[test]
    fn bytes_that_are_not_utf8_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.bin", &[0xff, 0xfe, 0x41]);
        let error = read_file_text(&path, None).unwrap_err();
        assert!(matches!(error, FileReadError::NotUtf8(_)));
        assert!(
            error
                .to_string()
                .ends_with("is not UTF-8 text, so it has no text to show")
        );
    }

    #[test]
    fn a_limit_that_cuts_a_character_makes_the_read_refused() {
        let dir = tempfile::tempdir().unwrap();
        // "é" is two bytes; a limit of one byte cuts it and the reader refuses it, as Node does.
        let path = write(&dir, "a.txt", "é".as_bytes());
        assert!(matches!(
            read_file_text(&path, Some(1)).unwrap_err(),
            FileReadError::NotUtf8(_)
        ));
    }

    #[test]
    fn a_directory_and_a_missing_path_are_not_files() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_file_text(dir.path().to_str().unwrap(), None).unwrap_err();
        assert!(matches!(error, FileReadError::NotAFile(_)));
        assert!(error.to_string().ends_with("is not a file"));
        let missing = dir.path().join("nope.txt");
        assert!(matches!(
            read_file_text(missing.to_str().unwrap(), None).unwrap_err(),
            FileReadError::NotAFile(_)
        ));
    }
}
