//! Whole-file writes that a concurrent reader never sees half-done.
//!
//! The TypeScript build writes a session's meta and definition files with `writeFileSync`, which a single
//! Node process cannot observe mid-write. In Rust the store is shared across threads (the server's goal
//! route reads a session's meta while a resumed round rewrites it), and `std::fs::write` truncates then
//! writes, so a reader can catch an empty or partial file and conclude the session does not exist. A
//! write here goes to a temporary file in the same directory and is renamed over the target, which POSIX
//! makes atomic: a reader sees the old bytes or the new ones, never a mix. The bytes written are exactly
//! the bytes given, so the files stay byte-identical to the TypeScript build's.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// The temporary path beside `path`: a dot-file (hidden from the tree, never `*.json`, so no listing reads
/// it) unique to this process and call.
fn temporary_beside(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.{}.{unique}.tmp", std::process::id()))
}

/// Replace `path` with `bytes` atomically: write a sibling temporary file, then rename it over
/// `path`. On failure the temporary file is removed and `path` is left as it was.
pub fn write_atomic(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    let path = path.as_ref();
    let temporary = temporary_beside(path);
    let written = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes.as_ref())?;
        // No fsync: atomicity for a concurrent reader comes from the rename alone, and the TypeScript
        // build's writeFileSync does not fsync either; a sync per write cost ~4 ms on every meta touch.
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn a_write_replaces_the_file_whole_and_leaves_nothing_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-x.json");
        write_atomic(&path, "{\n  \"id\": \"first\"\n}\n").unwrap();
        write_atomic(&path, "{\n  \"id\": \"second\"\n}\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"id\": \"second\"\n}\n"
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_failed_write_leaves_the_target_and_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kept.json");
        std::fs::write(&path, "old").unwrap();
        // Renaming a file over a directory fails, after the temporary file was written.
        let blocked = dir.path().join("a-directory");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("inside"), "x").unwrap();
        assert!(write_atomic(&blocked, "new").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        assert!(leftovers(dir.path()).is_empty());
    }
}
