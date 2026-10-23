//! Path arithmetic shared by the fence, the policy and the kernel profiles.
//!
//! Ported from `src/sandbox/paths.ts`. One canonicaliser and one containment test, because the last time the
//! comparison drifted it refused a write the policy had admitted: Seatbelt matches **resolved** paths
//! (`/tmp` is `/private/tmp` on macOS), and a root list canonicalised in one place but compared unresolved in
//! another says no for the wrong reason.

use std::path::{Path, PathBuf};

/// Node's `path.resolve(base, path)` on POSIX: `path` if absolute, else `base` joined with it, then
/// **lexically** normalised — `.` dropped, `..` pops a segment (never above `/`), repeated and trailing
/// separators removed. Nothing touches the filesystem; `base` is made absolute against the process's current
/// directory if it is relative.
pub fn resolve(base: &Path, path: &Path) -> PathBuf {
    let _ = (base, path);
    todo!("port path.resolve's POSIX normalisation")
}

/// Canonicalise a path for comparison (`canonical`).
///
/// The path is first made absolute against the current directory and lexically normalised ([`resolve`]);
/// then the **deepest existing ancestor** is passed through `realpath` and the missing tail is put back. The
/// `realpath` is what defeats a symlink inside the workspace that points at `/etc`; the tail is what makes this
/// usable for the file a tool is about to create, which is the common case, not an edge one. If not even `/`
/// resolves, the lexical absolute path is returned.
pub fn canonical(path: impl AsRef<Path>) -> PathBuf {
    let _ = path;
    todo!("port canonical from src/sandbox/paths.ts")
}

/// Whether `child` is `root` or sits under it, **by path component, not string prefix** (`contains`):
/// `/tmp/ws-extra` is not under `/tmp/ws`. Both arguments are expected canonical; nothing here touches the
/// filesystem.
///
/// One deliberate difference from the TypeScript test (`relative(root, child).startsWith('..')`): an entry
/// whose name merely *begins* with `..` (say `..cache`) is inside the root here, as it is on disk.
pub fn contains(root: &Path, child: &Path) -> bool {
    let _ = (root, child);
    todo!("component-wise containment")
}
