import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The in-page folder chooser's two host primitives: list one directory level, and create one child folder.
 *
 * DSH has two ways to pick a workspace directory. The native one (`dsh-host-directory-picker-native`) opens the
 * operating system's dialog **on the machine the harness runs on**, which only helps a person sitting at that
 * machine; the browse one (`dsh-host-directory-picker-browse`) lists the host's folders to an in-app *Select
 * Workspace Directory* dialog, which works from any browser, and DSH chooses it whenever the page may be remote.
 * heddle is reached through a gate and a public edge, so the page is usually remote: a native dialog would open on a
 * screen nobody is looking at while the request waits. This is the browse backend's contract, served by both servers
 * (`GET` and `POST /api/directories`) and drawn by the page's *Add workspace* dialog.
 *
 * - A listing names **directories only**, name-sorted, following symlinks to directories and skipping broken ones,
 *   with a `hidden` flag for dot-names, the host account's `home`, and `crumbs` from the root to the target. No path
 *   lists the home directory. At most {@link MAX_DIRECTORY_ENTRIES} rows come back and a cut level says
 *   `truncated: true` (DSH's bound).
 * - Creation is non-recursive and takes one path segment: a missing parent is a real failure, not a level to invent.
 *
 * Paths are canonical (`realpath`) on the way out, which is the form a workspace is registered under, so the folder a
 * person picks is the folder the tree then shows.
 */

/** The largest number of rows one listing returns; DSH's `maxEntries` default. */
export const MAX_DIRECTORY_ENTRIES = 1000

export interface DirectoryEntry {
  readonly name: string
  readonly path: string
  readonly hidden: boolean
}

export interface DirectoryCrumb {
  readonly name: string
  readonly path: string
}

export interface DirectoryListing {
  readonly path: string
  readonly home: string
  readonly parent: string | null
  readonly crumbs: readonly DirectoryCrumb[]
  readonly entries: readonly DirectoryEntry[]
  readonly truncated: boolean
}

/** A refusal with the status the route answers and DSH's stable code for it. */
export class DirectoryError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const UNREADABLE = 'directory-picker/unreadable'
const CREATE_FAILED = 'directory-picker/create-failed'
const EXISTS = 'directory-picker/exists'

/** `~` and `~/…` against the account's home; anything else as given. */
function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** An existing directory, canonical, or the refusal that says which of the three it is not. */
function existingDirectory(raw: string, home: string, code: string): string {
  const path = expandTilde(raw, home)
  if (!path.startsWith('/')) throw new DirectoryError('the path must be absolute', 400, code)
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new DirectoryError(`${raw} does not exist`, 400, code)
  }
  if (!statSync(real).isDirectory()) throw new DirectoryError(`${raw} is not a folder`, 400, code)
  return real
}

/** The root-to-target chain, every crumb a jump target; the root is labelled by its own path. */
function crumbsOf(path: string): DirectoryCrumb[] {
  const crumbs: DirectoryCrumb[] = [{ name: '/', path: '/' }]
  let at = ''
  for (const segment of path.split('/').filter((part) => part.length > 0)) {
    at = `${at}/${segment}`
    crumbs.push({ name: segment, path: at })
  }
  return crumbs
}

/** One directory level, as the page's chooser draws it. `raw` absent or blank lists the home directory. */
export function listDirectory(raw: string | undefined, home: string = homedir()): DirectoryListing {
  const requested = raw === undefined || raw.trim().length === 0 ? home : raw.trim()
  const path = existingDirectory(requested, home, UNREADABLE)
  let dirents
  try {
    dirents = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    throw new DirectoryError(`cannot read ${requested}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, 400, UNREADABLE)
  }
  const names: string[] = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      names.push(dirent.name)
    } else if (dirent.isSymbolicLink()) {
      try {
        if (statSync(join(path, dirent.name)).isDirectory()) names.push(dirent.name)
      } catch {
        // A broken or cyclic link is not a folder anyone can enter.
      }
    }
  }
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const kept = names.slice(0, MAX_DIRECTORY_ENTRIES)
  let realHome = home
  try {
    realHome = realpathSync(home)
  } catch {
    // A home that cannot be resolved is still the anchor the account names.
  }
  return {
    path,
    home: realHome,
    parent: path === '/' ? null : dirname(path),
    crumbs: crumbsOf(path),
    entries: kept.map((name) => ({ name, path: path === '/' ? `/${name}` : `${path}/${name}`, hidden: name.startsWith('.') })),
    truncated: names.length > kept.length,
  }
}

/** Create one child folder under an existing parent; answers the new folder's canonical path. */
export function createDirectory(parent: unknown, name: unknown, home: string = homedir()): { readonly path: string } {
  if (typeof parent !== 'string' || parent.trim().length === 0) throw new DirectoryError('a parent folder is required', 400, CREATE_FAILED)
  const leaf = typeof name === 'string' ? name.trim() : ''
  if (leaf.length === 0 || leaf === '.' || leaf === '..' || /[/\\\0]/.test(leaf)) {
    throw new DirectoryError('a folder name must be one path segment', 400, CREATE_FAILED)
  }
  const base = existingDirectory(parent.trim(), home, CREATE_FAILED)
  const target = base === '/' ? `/${leaf}` : `${base}/${leaf}`
  try {
    mkdirSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new DirectoryError(`${target} already exists`, 409, EXISTS)
    throw new DirectoryError(`could not create ${target}: ${code ?? (error as Error).message}`, 400, CREATE_FAILED)
  }
  return { path: target }
}
