//! Path arithmetic shared by the fence, the policy and the kernel profiles.
//!
//! Ported from `src/sandbox/paths.ts`. One canonicaliser and one containment test, because the last time the
//! comparison drifted it refused a write the policy had admitted: Seatbelt matches **resolved** paths
//! (`/tmp` is `/private/tmp` on macOS), and a root list canonicalised in one place but compared unresolved in
//! another says no for the wrong reason.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// Node's `path.resolve(base, path)` on POSIX: `path` if absolute, else `base` joined with it, then
/// **lexically** normalised — `.` dropped, `..` pops a segment (never above `/`), repeated and trailing
/// separators removed. Nothing touches the filesystem; `base` is made absolute against the process's current
/// directory if it is relative.
pub fn resolve(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        return normalise(path);
    }
    let base = if base.is_absolute() {
        base.to_path_buf()
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        cwd.join(base)
    };
    normalise(&base.join(path))
}

/// The lexical half of [`resolve`]: drop `.`, pop a segment for `..`, never climb above `/`.
fn normalise(path: &Path) -> PathBuf {
    let mut segments: Vec<OsString> = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) => segments.clear(),
            Component::CurDir => {}
            Component::ParentDir => {
                segments.pop();
            }
            Component::Normal(segment) => segments.push(segment.to_os_string()),
        }
    }
    let mut resolved = PathBuf::from("/");
    resolved.extend(segments);
    resolved
}

/// Canonicalise a path for comparison (`canonical`).
///
/// The path is first made absolute against the current directory and lexically normalised ([`resolve`]);
/// then the **deepest existing ancestor** is passed through `realpath` and the missing tail is put back. The
/// `realpath` is what defeats a symlink inside the workspace that points at `/etc`; the tail is what makes this
/// usable for the file a tool is about to create, which is the common case, not an edge one. If not even `/`
/// resolves, the lexical absolute path is returned.
pub fn canonical(path: impl AsRef<Path>) -> PathBuf {
    let absolute = match std::env::current_dir() {
        Ok(cwd) => resolve(&cwd, path.as_ref()),
        Err(_) => resolve(Path::new("/"), path.as_ref()),
    };
    let mut missing: Vec<OsString> = Vec::new();
    let mut current = absolute.clone();
    loop {
        match std::fs::canonicalize(&current) {
            Ok(existing) => {
                if missing.is_empty() {
                    return existing;
                }
                missing.reverse();
                return existing.join(PathBuf::from_iter(missing));
            }
            Err(_) => {
                let Some(parent) = current.parent() else {
                    return absolute;
                };
                let name = current
                    .file_name()
                    .map_or_else(OsString::new, |name| name.to_os_string());
                if name.is_empty() {
                    return absolute;
                }
                missing.push(name);
                current = parent.to_path_buf();
            }
        }
    }
}

/// Whether `child` is `root` or sits under it, **by path component, not string prefix** (`contains`):
/// `/tmp/ws-extra` is not under `/tmp/ws`. Both arguments are expected canonical; nothing here touches the
/// filesystem.
///
/// One deliberate difference from the TypeScript test (`relative(root, child).startsWith('..')`): an entry
/// whose name merely *begins* with `..` (say `..cache`) is inside the root here, as it is on disk.
pub fn contains(root: &Path, child: &Path) -> bool {
    let mut root = root.components();
    let mut child = child.components();
    loop {
        match (root.next(), child.next()) {
            (None, _) => return true,
            (Some(left), Some(right)) if left == right => {}
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{canonical, contains, resolve};
    use crate::testfs::TempDir;

    fn path(text: &str) -> PathBuf {
        PathBuf::from(text)
    }

    #[test]
    fn resolve_normalises_dots_and_doubled_separators() {
        assert_eq!(resolve(&path("/a/b"), &path("../c/./d")), path("/a/c/d"));
        assert_eq!(resolve(&path("/a/"), &path("b//c/")), path("/a/b/c"));
        assert_eq!(resolve(&path("/a/b"), &path("./")), path("/a/b"));
    }

    #[test]
    fn resolve_keeps_an_absolute_path_and_ignores_the_base() {
        assert_eq!(resolve(&path("/a/b"), &path("/x/../y")), path("/y"));
        assert_eq!(resolve(&path("/a/b"), &path("/")), path("/"));
    }

    #[test]
    fn resolve_never_climbs_above_the_root() {
        assert_eq!(resolve(&path("/a"), &path("../../b")), path("/b"));
        assert_eq!(resolve(&path("/"), &path("..")), path("/"));
    }

    #[test]
    fn resolve_makes_a_relative_base_absolute_against_the_current_directory() {
        let resolved = resolve(&path("relative/base"), &path("child"));
        assert!(resolved.is_absolute(), "{resolved:?} is absolute");
        assert!(resolved.ends_with("relative/base/child"), "{resolved:?}");
    }

    #[test]
    fn canonical_resolves_a_symlink_out_of_the_workspace() {
        let dir = TempDir::new("canonical-out");
        let workspace = dir.child("ws");
        let link = workspace.join("escape");
        crate::testfs::symlink(Path::new("/etc"), &link);

        let resolved = canonical(link.join("passwd"));
        assert_eq!(
            resolved,
            canonical("/etc/passwd"),
            "the link is followed to the real /etc, not compared as a workspace path"
        );
        assert!(!contains(&canonical(&workspace), &resolved));
    }

    #[test]
    fn canonical_keeps_a_missing_tail_under_the_deepest_existing_ancestor() {
        let dir = TempDir::new("canonical-tail");
        let workspace = dir.child("ws");
        let missing = workspace.join("new/deeper/file.txt");

        assert_eq!(
            canonical(&missing),
            canonical(&workspace).join("new/deeper/file.txt")
        );
    }

    #[test]
    fn canonical_of_an_existing_path_is_the_real_path() {
        let dir = TempDir::new("canonical-real");
        let file = dir.join("file.txt");
        std::fs::write(&file, b"x").expect("write the test file");

        assert_eq!(canonical(&file), std::fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn contains_compares_components_not_prefixes() {
        assert!(contains(&path("/tmp/ws"), &path("/tmp/ws")));
        assert!(contains(&path("/tmp/ws"), &path("/tmp/ws/a/b")));
        assert!(
            !contains(&path("/tmp/ws"), &path("/tmp/ws-extra")),
            "a sibling whose name begins with the root's is outside it"
        );
        assert!(!contains(&path("/tmp/ws"), &path("/tmp")));
        assert!(!contains(&path("/tmp/ws/a"), &path("/tmp/ws")));
        assert!(contains(&path("/"), &path("/anything")));
    }

    #[test]
    fn contains_admits_an_entry_named_with_leading_dots() {
        assert!(
            contains(&path("/tmp/ws"), &path("/tmp/ws/..cache")),
            "on disk ..cache is a normal name inside the root"
        );
    }
}
