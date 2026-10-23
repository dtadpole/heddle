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
    todo!("port isInside from src/server/docs.ts")
}

/// Every `.md`/`.markdown`/`.mdx` file below `root`, sorted by path, within `options`' bounds. An unreadable
/// directory contributes nothing; it is not an error.
pub fn find_docs(root: &Path, options: FindDocsOptions) -> Vec<DocEntry> {
    todo!("port findDocs from src/server/docs.ts")
}

/// The UTF-8 text of the markdown document at a caller-supplied path relative to `root`.
pub fn read_doc(root: &Path, path: &str) -> Result<String, DocError> {
    todo!("port readDoc from src/server/docs.ts")
}
