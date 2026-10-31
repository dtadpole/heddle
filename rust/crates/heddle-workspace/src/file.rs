//! Reading a text file for the right panel, refusing what a viewer cannot show.
//!
//! Ported from `readFileText` in `src/session/tree.ts`. Three refusals, each a sentence a person can
//! act on: a directory or a missing path is not a file; a binary (a NUL byte in what is read) is not
//! text; bytes that are not UTF-8 are not text (a literal U+FFFD is text). A file longer than the limit is
//! **truncated and says so** rather than refused, and when the limit cuts a character the text is the complete
//! characters before it. This is a view, not a way around the sandbox: the caller decides which paths
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
    /// The file is longer than the limit, so `text` is its beginning: the complete characters before the limit.
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
    /// `<path> is not UTF-8 text, so it has no text to show` — bytes in what is read that are not UTF-8. A
    /// character the limit cut is not one of them: the reading keeps the complete characters before it.
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
    let truncated = whole.len() > slice.len();
    let Some(text) = decode_utf8(slice, truncated) else {
        return Err(FileReadError::NotUtf8(canonical));
    };
    let text = text.to_owned();
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
        truncated,
    })
}

/// The slice's text, or `None` when its bytes are not UTF-8 (issue #78).
///
/// Decoded **strictly**, so a literal U+FFFD in the file is a character like any other and only bytes that are not
/// UTF-8 are refused — DSH's reader decodes with `TextDecoder('utf-8', { fatal: true })` (dsh-fs-local
/// lib/index.js:454). When the limit cut the file, its last character may be cut too: an error with no
/// [`error_len`](std::str::Utf8Error::error_len) is a sequence that is valid so far and ends with the slice, and the
/// text is then the complete characters before it ([`valid_up_to`](std::str::Utf8Error::valid_up_to)). That is what
/// the TypeScript build's stream-mode decode keeps, and how DSH decodes across chunks (:342). A file the limit did not
/// cut has no such excuse, so a final incomplete character is refused.
fn decode_utf8(slice: &[u8], truncated: bool) -> Option<&str> {
    match std::str::from_utf8(slice) {
        Ok(text) => Some(text),
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&slice[..error.valid_up_to()]).ok()
        }
        Err(_) => None,
    }
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

    // Issue #78: the four controls, the same as `test/tree.test.ts`'s.

    #[test]
    fn a_limit_at_a_character_boundary_keeps_every_byte_it_read() {
        let dir = tempfile::tempdir().unwrap();
        // "ab中cd": the three bytes of 中 are 2..4.
        let path = write(&dir, "wide.txt", "ab中cd".as_bytes());
        let reading = read_file_text(&path, Some(5)).unwrap();
        assert_eq!(reading.text, "ab中");
        assert!(reading.truncated);
        assert_eq!(reading.bytes, 7);
    }

    #[test]
    fn a_limit_that_cuts_a_character_keeps_the_whole_characters_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "wide.txt", "ab中cd".as_bytes());
        for limit in [3, 4] {
            let reading = read_file_text(&path, Some(limit)).unwrap();
            assert_eq!(reading.text, "ab", "a limit of {limit} cuts 中");
            assert!(reading.truncated, "truncated, not refused");
            assert_eq!(reading.lines, 1);
            assert_eq!(reading.bytes, 7, "the size is still the whole file's");
        }
        // "😀" is four bytes, 1..4: cut after one, two or three of them.
        let emoji = write(&dir, "emoji.txt", "x😀y".as_bytes());
        for limit in [2, 3, 4] {
            let reading = read_file_text(&emoji, Some(limit)).unwrap();
            assert_eq!(reading.text, "x", "a limit of {limit} cuts 😀");
            assert!(reading.truncated);
        }
        // "é" is two bytes: a two-byte character cut after its first byte.
        let accent = write(&dir, "accent.txt", "abé!".as_bytes());
        let reading = read_file_text(&accent, Some(3)).unwrap();
        assert_eq!(reading.text, "ab");
        assert!(reading.truncated);
        // Nothing whole before the cut: the text is empty and still truncated.
        let accent = write(&dir, "accent-only.txt", "é".as_bytes());
        let reading = read_file_text(&accent, Some(1)).unwrap();
        assert_eq!((reading.text.as_str(), reading.lines), ("", 0));
        assert!(reading.truncated);
    }

    #[test]
    fn a_literal_replacement_character_is_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            &dir,
            "replacement.txt",
            "a literal \u{FFFD} is a character\n".as_bytes(),
        );
        let reading = read_file_text(&path, None).unwrap();
        assert_eq!(reading.text, "a literal \u{FFFD} is a character\n");
        assert!(!reading.truncated);
    }

    #[test]
    fn bytes_that_are_not_utf8_are_refused_wherever_they_are() {
        let dir = tempfile::tempdir().unwrap();
        let refused = |path: &str, limit: Option<usize>| {
            let error = read_file_text(path, limit).unwrap_err();
            assert!(matches!(error, FileReadError::NotUtf8(_)), "{error}");
            assert!(
                error
                    .to_string()
                    .ends_with("is not UTF-8 text, so it has no text to show")
            );
        };
        let invalid = write(&dir, "invalid.txt", &[0x61, 0xff, 0x62, 0x0a]);
        refused(&invalid, None);
        refused(&invalid, Some(3));
        // A file that itself ends inside a character: no limit cut it, so it is not UTF-8.
        refused(
            &write(&dir, "ends-cut.txt", &[0x61, 0x62, 0xe4, 0xb8]),
            None,
        );
        // Bytes at the cut that begin no character (E0 80) are refused, not dropped as a cut character.
        refused(
            &write(&dir, "bad-lead.txt", &[0x61, 0x62, 0xe0, 0x80, 0x80]),
            Some(4),
        );
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
