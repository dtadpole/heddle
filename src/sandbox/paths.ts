import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Path arithmetic shared by the fence, the policy and the kernel profiles.
 *
 * It lives in one module because the last time it drifted it produced a measured bug: the Seatbelt profile
 * matches **resolved** paths (`/tmp` is `/private/tmp` on macOS), so a root list canonicalised in one place and
 * compared unresolved in another refused a write the policy had admitted. One canonicaliser, one containment
 * test, three consumers.
 */

/**
 * Canonicalise a path for comparison.
 *
 * `realpath` is what defeats the symlink case: a link inside the workspace that
 * points at `/etc` resolves to `/etc` before the comparison, so it is refused. A
 * path that does not exist yet cannot be resolved, so its deepest existing
 * ancestor is resolved instead and the rest is kept — which is what makes this
 * usable for a file a tool is about to create.
 */
export function canonical(path: string): string {
  const absolute = resolve(path)
  /**
   * Resolve the deepest ancestor that exists, then put the missing tail back.
   *
   * The tail is the whole point, and the first version of this got it wrong in a way that made a
   * **new** file look like it was outside the workspace: measured, `canonical` returned the path
   * unresolved whenever any parent was missing, so `/var/folders/.../scratch.txt` stayed
   * `/var/folders/...` instead of becoming `/private/var/folders/...`, and a write the policy had
   * admitted was refused. A tool's most common path is a file that does not exist yet, so this is the
   * common case rather than an edge one.
   *
   * `realpath` on the existing prefix is what defeats a symlink inside the workspace pointing out of
   * it; the tail needs no resolution because it does not exist.
   */
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Whether `child` is `root` or sits under it, by path segment rather than prefix. */
export function contains(root: string, child: string): boolean {
  if (child === root) return true
  const rel = relative(root, child)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}
