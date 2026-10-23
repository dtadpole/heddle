//! The path rules a workspace, a session's folder and a folder tree are all made of.
//!
//! Ported from `src/paths.ts`, plus [`resolve`], which is Node's `path.resolve` — the TypeScript build
//! called it everywhere a path was made absolute, and Rust's `std::path::absolute` does **not** fold
//! `..` on Unix, so a direct substitute would make `/a/b/../c` and `/a/c` two workspaces.
//!
//! The sandbox keeps its own `canonical` and `contains` (`src/sandbox/paths.ts`, ported in
//! `heddle-sandbox`); these are the ones the session, workspace, server and command line share.

use std::path::{Component, Path, PathBuf};

/// `path` made absolute against `base` and folded lexically, as Node's `path.resolve(base, path)`:
/// an absolute `path` ignores `base`, `.` segments vanish, `..` pops one segment and never climbs above
/// the root, and no trailing separator survives. The filesystem is not consulted.
pub fn resolve(base: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut folded = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(prefix) => folded.push(prefix.as_os_str()),
            Component::RootDir => folded.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                folded.pop();
            }
            Component::Normal(segment) => folded.push(segment),
        }
    }
    folded
}

/// [`resolve`] against the process's working directory, as Node's one-argument `path.resolve`.
pub fn resolve_from_cwd(path: &Path) -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    resolve(&cwd, path)
}

/// A canonical absolute path: `realpath` when the path exists, [`resolve_from_cwd`] when it does not.
///
/// A workspace is associated by its path, so the path has to be one canonical string rather than
/// whatever spelling a caller typed: `/tmp/x` and `/private/tmp/x` are one directory on macOS, and a
/// trailing slash is not a different folder. The lexical fallback exists because a workspace may be
/// registered before its directory exists, and recording nothing would lose the registration.
pub fn canonical_path(path: &Path) -> PathBuf {
    let absolute = resolve_from_cwd(path);
    std::fs::canonicalize(&absolute).unwrap_or(absolute)
}

/// Is `child` at or below `parent`, compared **by path segment**?
///
/// Segment-wise, never string-wise, and that is the whole point: `/a/b-sibling` shares every character
/// of `/a/b` and is not inside it. Both paths are expected to be absolute and canonical already; a
/// trailing separator on either side does not change the answer.
pub fn is_under(parent: &Path, child: &Path) -> bool {
    child.starts_with(parent)
}

/// How many named segments a path has, so a set of roots can be ordered nearest-first: `/` is 0,
/// `/a/b` is 2.
pub fn depth_of(path: &Path) -> usize {
    path.components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_folds_dot_and_dot_dot_lexically() {
        assert_eq!(
            resolve(Path::new("/a/b"), Path::new("../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(
            resolve(Path::new("/a"), Path::new("../../..")),
            PathBuf::from("/")
        );
        assert_eq!(
            resolve(Path::new("/ignored"), Path::new("/x/y/")),
            PathBuf::from("/x/y")
        );
    }

    #[test]
    fn a_sibling_sharing_a_prefix_is_not_under() {
        assert!(!is_under(Path::new("/a/b"), Path::new("/a/b-sibling")));
        assert!(is_under(Path::new("/a/b"), Path::new("/a/b/c")));
        assert!(is_under(Path::new("/a/b"), Path::new("/a/b")));
        assert!(is_under(Path::new("/a/b/"), Path::new("/a/b/c")));
        assert!(!is_under(Path::new("/a/b/c"), Path::new("/a/b")));
    }

    #[test]
    fn depth_counts_named_segments() {
        assert_eq!(depth_of(Path::new("/")), 0);
        assert_eq!(depth_of(Path::new("/a/b")), 2);
        assert_eq!(depth_of(Path::new("/a/b/")), 2);
    }

    #[test]
    fn canonical_path_falls_back_to_the_lexical_path_when_missing() {
        let missing = Path::new("/no/such/heddle/dir/../leaf");
        assert_eq!(
            canonical_path(missing),
            PathBuf::from("/no/such/heddle/leaf")
        );
    }

    #[test]
    fn canonical_path_resolves_a_symlink_when_present() {
        let root = std::env::temp_dir().join(format!("heddle-config-paths-{}", std::process::id()));
        let target = root.join("target");
        let link = root.join("link");
        std::fs::create_dir_all(&target).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let resolved = canonical_path(&link);
        let expected = std::fs::canonicalize(&target).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(resolved, expected);
    }
}
