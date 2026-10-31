import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * The path rules a workspace and a folder tree are both made of.
 *
 * Two functions, and they are here rather than inside the workspace because three callers now
 * need them — the workspace record, the session service that binds a session to a folder, and the
 * tree that walks one. They lived in `workspace/service.ts` until the tree arrived, and a second
 * copy is how two callers come to disagree about whether `/a/b-sibling` is inside `/a/b`.
 */

/**
 * A canonical absolute path: `realpath` when the directory exists, `resolve` when it does not.
 *
 * A workspace is associated by its path, so the path has to be one canonical string rather than
 * whatever spelling a caller happened to type: `/tmp/x` and `/private/tmp/x` are one directory on
 * macOS, and a trailing slash is not a different folder. `resolve` is the fallback because a
 * workspace may be registered before the directory exists, and recording nothing would lose the
 * registration rather than postpone it.
 *
 * The **native** `realpath`, not Node's JavaScript one, because only the native call returns the
 * spelling the disk stores: on a case-insensitive volume (macOS by default) `~/Proj` and `~/proj` are one
 * folder, and the JavaScript walk hands back whatever case was typed, so each spelling became a workspace
 * of its own. DSH canonicalises with `fs/promises` `realpath`, which is the native call
 * (`dsh-workspace/lib/index.js:36-51`: symlinks, `..` and trailing slashes resolved, and a symlink to a
 * registered folder collides with it — `dsh-workspace/README.md:93`), and the Rust port's
 * `std::fs::canonicalize` is `realpath(3)` too, so all three now store the same string.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/**
 * Is `child` at or below `parent`, compared **by path segment**?
 *
 * Segment-wise, never string-wise, and that is the whole point: `/a/b-sibling` shares every character
 * of `/a/b` and is not inside it. Measured as a real trap — a substring comparison puts a sibling
 * project inside its neighbour, and the fault is invisible until two folders happen to share a name
 * prefix.
 */
export function isUnder(parent: string, child: string): boolean {
  if (parent === child) return true
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}

/** How deep a path is, so a set of roots can be ordered nearest-first. */
export function depthOf(path: string): number {
  return path.split(sep).filter(Boolean).length
}
