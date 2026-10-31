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

/// Where a path is, or was: the `realpath` of its **deepest existing ancestor** with the missing tail put back —
/// `canonicalPathThroughAncestors` in `src/paths.ts`.
///
/// For a folder that exists this is [`canonical_path`]. For one that is gone it is the spelling its record was stored
/// under while it existed, which the lexical fallback cannot give once a link sits on the way: a workspace registered
/// at `/tmp/x/w` is stored as `/private/tmp/x/w` on macOS, and after the folder is deleted or moved the lexical
/// `/tmp/x/w` names no record and no root (GitHub issue #141). [`canonical_path`] keeps its fallback; this is for the
/// questions about a folder that may be gone. `heddle-sandbox`'s `paths::canonical` resolves a missing tail the same way.
pub fn canonical_path_through_ancestors(path: &Path) -> PathBuf {
    let absolute = resolve_from_cwd(path);
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut current = absolute.clone();
    loop {
        if let Ok(existing) = std::fs::canonicalize(&current) {
            return missing
                .iter()
                .rev()
                .fold(existing, |path, segment| path.join(segment));
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_os_string());
                current = parent.to_path_buf();
            }
            _ => return absolute,
        }
    }
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

    /// A folder that is gone keeps the spelling its record was stored under: the real path of what still exists,
    /// with the missing tail put back (#141). `canonical_path` itself keeps its lexical fallback.
    #[test]
    fn a_folder_that_is_gone_is_spelled_through_the_real_path_of_its_deepest_existing_ancestor() {
        let root = std::env::temp_dir().join(format!(
            "heddle-config-through-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let real = root.join("real");
        let alias = root.join("alias");
        std::fs::create_dir_all(real.join("here")).unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let canonical_real = std::fs::canonicalize(&real).unwrap();
        let here = canonical_path_through_ancestors(&alias.join("here"));
        let gone = canonical_path_through_ancestors(&alias.join("gone").join("deeper"));
        let dotted = canonical_path_through_ancestors(&alias.join("gone/../gone/"));
        let lexical = canonical_path(&alias.join("gone"));
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            here,
            canonical_real.join("here"),
            "an existing folder is its real path"
        );
        assert_eq!(
            gone,
            canonical_real.join("gone").join("deeper"),
            "a missing tail is kept under the real path of what exists"
        );
        assert_eq!(
            dotted,
            canonical_real.join("gone"),
            "dots and a trailing separator are folded first"
        );
        assert_eq!(
            lexical,
            alias.join("gone"),
            "canonical_path keeps its lexical fallback"
        );
    }
}
