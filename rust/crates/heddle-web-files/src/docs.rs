//! The document store a right-hand view can list and read — the port of `src/server/docs.ts`.
//!
//! **No route calls this in the TypeScript build any more**: the Docs tab it served was removed (claim 1 of
//! `_verifiers_/88-file-preview` asserts the page offers no document list). It is ported last, as a library, so the
//! crate's source map stays whole; if the coordinator rules it out, this module is deleted rather than kept dead.
//!
//! The rules, judged without a server: one fixed root; a bounded walk that skips dependency trees, VCS metadata,
//! build output and hidden entries; and a resolved path checked to be inside the root **by path segment**, so a
//! sibling whose name starts with the root's name is not mistaken for it.

use std::path::Path;

/// How much of one document may be read and rendered.
pub const MAX_DOC_BYTES: u64 = 512 * 1024;

/// Directories a person's documents are never in, and which would otherwise dominate a listing.
pub(crate) const SKIP: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    ".heddle-tmp",
    ".venv",
    "coverage",
    ".next",
    "build",
];

/// One document, as the listing describes it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DocEntry {
    /// The path relative to the root, `/`-separated — what a caller asks [`read_doc`] for.
    pub path: String,
    pub bytes: u64,
}

/// Bounds on a listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FindDocsOptions {
    /// The most documents a listing holds (default 200).
    pub max: usize,
    /// The deepest directory level the walk enters (default 6).
    pub depth: usize,
}

impl Default for FindDocsOptions {
    fn default() -> Self {
        Self { max: 200, depth: 6 }
    }
}

/// A refused read, with the sentence that says which rule it broke.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DocError {
    #[error("a path is required")]
    PathRequired,
    #[error("that path is outside the document root")]
    OutsideRoot,
    #[error("only a markdown document can be read here")]
    NotMarkdown,
    #[error("not a file")]
    NotAFile,
    #[error("the document is larger than {} bytes", MAX_DOC_BYTES)]
    TooLarge,
    #[error("no such document")]
    NoSuchDocument,
}

/// Whether `child` is `root` or inside it, after both are resolved lexically, compared by path segment.
pub fn is_inside(root: &Path, child: &Path) -> bool {
    let root = resolve_lexically(root);
    let child = resolve_lexically(child);
    child == root || child.starts_with(&root)
}

/// Node's `path.resolve` for one path: absolute, `.` dropped and `..` popped, without touching the filesystem.
fn resolve_lexically(path: &Path) -> std::path::PathBuf {
    let mut segments: Vec<std::ffi::OsString> = Vec::new();
    let mut absolute = path.has_root();
    let joined = if absolute {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(current) => current.join(path),
            Err(_) => path.to_path_buf(),
        }
    };
    if !absolute {
        absolute = joined.has_root();
    }
    for component in joined.components() {
        match component {
            std::path::Component::RootDir => {
                segments.clear();
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                segments.pop();
            }
            std::path::Component::Normal(name) => segments.push(name.to_os_string()),
            std::path::Component::Prefix(_) => {}
        }
    }
    let mut resolved = std::path::PathBuf::new();
    if absolute {
        resolved.push(std::path::MAIN_SEPARATOR.to_string());
    }
    for segment in segments {
        resolved.push(segment);
    }
    resolved
}

/// Every `.md`/`.markdown`/`.mdx` file below `root`, sorted by path, within `options`' bounds. An unreadable
/// directory contributes nothing; it is not an error.
pub fn find_docs(root: &Path, options: FindDocsOptions) -> Vec<DocEntry> {
    let root = resolve_lexically(root);
    let mut found: Vec<DocEntry> = Vec::new();
    walk_documents(&root, &root, 0, options, &mut found);
    found.sort_by(|left, right| left.path.cmp(&right.path));
    found
}

/// The bounded walk: hidden entries and the skip list contribute nothing, and an unreadable directory is not an
/// error.
fn walk_documents(
    root: &Path,
    directory: &Path,
    depth: usize,
    options: FindDocsOptions,
    found: &mut Vec<DocEntry>,
) {
    if found.len() >= options.max || depth > options.depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    // A stable listing is what a caller can diff; read_dir's own order is the filesystem's.
    names.sort();
    for name in names {
        if found.len() >= options.max {
            return;
        }
        if name.starts_with('.') {
            continue;
        }
        let full = directory.join(&name);
        let Ok(metadata) = std::fs::symlink_metadata(&full) else {
            continue;
        };
        if metadata.is_dir() {
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            walk_documents(root, &full, depth + 1, options, found);
            continue;
        }
        if !metadata.is_file() || !is_markdown(&name) {
            continue;
        }
        let path = full
            .strip_prefix(root)
            .unwrap_or(&full)
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<String>>()
            .join("/");
        found.push(DocEntry {
            path,
            bytes: metadata.len(),
        });
    }
}

/// `/\.(?:md|markdown|mdx)$/i`: what counts as a document.
fn is_markdown(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")
}

/// The UTF-8 text of the markdown document at a caller-supplied path relative to `root`.
pub fn read_doc(root: &Path, path: &str) -> Result<String, DocError> {
    if path.is_empty() {
        return Err(DocError::PathRequired);
    }
    let target = resolve_lexically(&resolve_lexically(root).join(path));
    if !is_inside(root, &target) {
        return Err(DocError::OutsideRoot);
    }
    if !is_markdown(&target.to_string_lossy()) {
        return Err(DocError::NotMarkdown);
    }
    let Ok(metadata) = std::fs::metadata(&target) else {
        return Err(DocError::NoSuchDocument);
    };
    if !metadata.is_file() {
        return Err(DocError::NotAFile);
    }
    if metadata.len() > MAX_DOC_BYTES {
        return Err(DocError::TooLarge);
    }
    std::fs::read_to_string(&target).map_err(|_| DocError::NoSuchDocument)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "hd-docs-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn the_listing_is_sorted_bounded_and_skips_what_is_not_a_document() {
        let root = scratch("listing");
        std::fs::write(root.join("b.md"), "b").unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("notes.txt"), "no").unwrap();
        std::fs::write(root.join(".hidden.md"), "no").unwrap();
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/c.markdown"), "c").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/dep.md"), "no").unwrap();
        std::fs::create_dir_all(root.join("deep/one/two")).unwrap();
        std::fs::write(root.join("deep/one/two/e.mdx"), "e").unwrap();

        let listing = find_docs(&root, FindDocsOptions::default());
        let paths: Vec<&str> = listing.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(
            paths,
            ["a.md", "b.md", "deep/one/two/e.mdx", "nested/c.markdown"],
            "hidden entries, non-documents and dependency trees are not listed"
        );
        assert_eq!(listing[0].bytes, 1);

        let bounded = find_docs(&root, FindDocsOptions { max: 2, depth: 6 });
        assert_eq!(bounded.len(), 2, "the listing stops at its bound");
        let shallow = find_docs(&root, FindDocsOptions { max: 200, depth: 0 });
        assert_eq!(
            shallow
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<&str>>(),
            ["a.md", "b.md"],
            "a depth bound keeps the walk at the top"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_document_is_read_only_from_inside_the_root() {
        let root = scratch("read");
        std::fs::write(root.join("a.md"), "# A\n").unwrap();
        assert_eq!(read_doc(&root, "a.md").unwrap(), "# A\n");
        assert_eq!(read_doc(&root, "").unwrap_err(), DocError::PathRequired);
        assert_eq!(
            read_doc(&root, "../outside.md").unwrap_err(),
            DocError::OutsideRoot
        );
        assert_eq!(read_doc(&root, "a.txt").unwrap_err(), DocError::NotMarkdown);
        assert_eq!(
            read_doc(&root, "missing.md").unwrap_err(),
            DocError::NoSuchDocument
        );
        std::fs::create_dir_all(root.join("folder")).unwrap();
        assert_eq!(
            read_doc(&root, "folder").unwrap_err(),
            DocError::NotMarkdown
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_sibling_whose_name_begins_with_the_roots_name_is_not_inside_it() {
        let base = scratch("sibling");
        let root = base.join("project");
        let sibling = base.join("project-two");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(is_inside(&root, &root.join("a.md")), "a child is inside");
        assert!(is_inside(&root, &root), "the root itself is inside");
        assert!(
            !is_inside(&root, &sibling.join("a.md")),
            "a string prefix is not a path prefix"
        );
        std::fs::write(sibling.join("secret.md"), "x").unwrap();
        assert_eq!(
            read_doc(&root, "../project-two/secret.md").unwrap_err(),
            DocError::OutsideRoot
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_document_over_the_ceiling_is_refused_by_name() {
        let root = scratch("large");
        let path = root.join("big.md");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_DOC_BYTES + 1)
            .unwrap();
        assert_eq!(read_doc(&root, "big.md").unwrap_err(), DocError::TooLarge);
        let _ = std::fs::remove_dir_all(&root);
    }
}
