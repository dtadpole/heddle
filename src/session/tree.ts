import { readFileSync, readdirSync, statSync, type Stats } from 'node:fs'
import { basename, join, sep } from 'node:path'

import { canonicalPath, depthOf, isUnder } from '../paths.ts'
import { readSessionDefinition } from './definition.ts'
import type { SessionMeta } from './store.ts'

/**
 * The folder tree the Web UI's left column shows, and the content a file node opens.
 *
 * This is a **derivation**, not a service: `tree()` is handed the roots, the sessions and the names
 * of any generated folders, and answers with nodes. Two properties make it the thing a check can
 * judge without a browser:
 *
 * - **One level at a time.** A node's `children` is the array of its direct children when the caller
 *   asked for that node, and `null` when it did not. `null` and `[]` mean different things — "not
 *   asked" and "asked and empty" — and the difference is what makes the tree lazy.
 * - **Folders and files, folders first.** A folder is the navigation and a file is the leaf: the
 *   owner asked for the files to be shown on 2026-10-11, reversing this module's first rule, which
 *   enumerated folders only on the reasoning that a leaf is reached by opening the transcript rather
 *   than by browsing. What is still not enumerated is what nobody means by "content": dot-entries,
 *   `node_modules`, `__pycache__`.
 *
 * The classification is the conventions repository's own, restated here rather than read from it:
 * a type folder is a plural noun in underscores, an instance is kebab-case and sits directly inside
 * a type folder, and a type may repeat at any depth — including inside an instance. Nothing is read
 * from that repository, so heddle does not depend on one machine's layout; a registered-type
 * vocabulary is optional configuration elsewhere and is not needed to render.
 */

export type NodeKind = 'roots' | 'workspace' | 'type' | 'instance' | 'folder' | 'generated' | 'file' | 'session'

/** What a folder's session contributes to its row. */
export interface TreeSession {
  readonly id: string
  readonly turns: number
  readonly title?: string
  /** When it started, so a row can say how long ago it was — DSH's own session rows carry an age. */
  readonly created: string
  /** When it was last written to: the age a row shows, and the order sessions inside one folder take. */
  readonly updated?: string
}

export interface TreeNode {
  readonly path: string
  readonly kind: NodeKind
  readonly label: string
  /** The type's short name, for a type folder; `null` everywhere else. */
  readonly badge: string | null
  readonly session: TreeSession | null
  /** Direct children when they were asked for, `null` when they were not; `[]` for a file. */
  readonly children: readonly TreeNode[] | null
  /** A file's size, so a row can say how big it is without opening it. */
  readonly bytes?: number
  /** A session's pin, so it can be held at the top and marked there. */
  readonly pinned?: boolean
  /** When it was pinned, which is the order among pinned sessions: the list is a pin stack, not a name sort. */
  readonly pinnedAt?: string
  /** A session the owner put away — only drawn when archived sessions were asked for. */
  readonly archived?: boolean
  /**
   * The adopted roots, on the virtual root node only.
   *
   * They are returned beside the tree rather than inside it because they are not a project a person
   * named: they exist because a session ran in that folder, and listing them apart is what lets the
   * UI show them as ad-hoc work while keeping every session reachable.
   */
  readonly adHoc?: readonly TreeNode[]
}

/** A registered root, as the workspace record states it. */
export interface TreeRoot {
  readonly path: string
  readonly title: string
  /** How the root came to exist; absent means a person registered it. See `WorkspaceRecord.origin`. */
  readonly origin?: 'added' | 'auto'
}

export interface TreeInput {
  readonly roots: readonly TreeRoot[]
  /** Every session, in any order; the newest bound to a folder is that folder's session. */
  readonly sessions: readonly SessionMeta[]
  /** Folder names a tool writes, matched by name, as the conventions linter's `--generated` names one. */
  readonly generated?: readonly string[]
  /**
   * Which archived sessions to draw — DSH's three states, not a boolean.
   *
   * `hide` is the default because a row a person put away is not one they asked for; `show` adds them back with
   * their marker; `only` answers "where did it go", which a two-state toggle cannot.
   */
  readonly archived?: 'hide' | 'show' | 'only'
}

/** A plural noun wrapped in underscores. A single underscore is not enough. */
const TYPE_FOLDER = /^_[a-z0-9]+(_[a-z0-9]+)*_$/

/** Kebab-case, two to four lowercase words. */
const INSTANCE_NAME = /^[a-z0-9]+(-[a-z0-9]+){1,3}$/

/**
 * The type folder whose instances are a branch's **sessions**.
 *
 * It is named here rather than derived because it is a name the conventions gave a meaning to, and the
 * tree gives that meaning a shape: the folder is not a node, and each instance inside it is shown as a
 * session at the top of the branch it belongs to (owner's rule, 2026-10-11).
 */
const SESSIONS_FOLDER = '_sessions_'

/** Folders nothing means by "content", so the tree does not enumerate them. */
const PLUMBING = new Set(['node_modules', '__pycache__'])

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * The badges a name is known by when the derivation below does not give the one people use.
 *
 * The owner's correction of 2026-10-11: `_context_` is called **`CTX`** in this UI. The derivation says
 * otherwise — dropping the vowels of `context` leaves `cntxt`, so its three letters are `CNT` — and the
 * derived badge is not *wrong*, it is just not the abbreviation a reader recognises. The exception is
 * written down here rather than bent into the rule, because the rule is right for the other names it is
 * asked about (`VRF`, `TLS`, `CNV`, `CNS`) and an exception that is stated is a fact while one that is
 * hidden in the arithmetic is a surprise.
 */
const BADGE_OVERRIDES: Readonly<Record<string, string>> = { context: 'CTX' }

/**
 * A type's badge: its name with the vowels dropped, uppercased, three letters.
 *
 * The rule is not decoration. Two letters would collide on the three types that matter most here —
 * `_context_`, `_conventions_` and `_constitutions_` all begin `co` — and dropping the vowels gives
 * `CNT`, `CNV` and `CNS`, which do not. When fewer than three consonants remain the full name
 * supplies the rest, so `_web_` does not become a one-letter badge. A name whose derived badge is not
 * the one in use is listed in `BADGE_OVERRIDES` above.
 */
export function badgeFor(name: string): string {
  const letters = name.replace(/_/g, '').toLowerCase()
  const override = BADGE_OVERRIDES[letters]
  if (override !== undefined) return override
  const consonants = letters.replace(/[aeiou]/g, '')
  const source = consonants.length >= 3 ? consonants : letters
  return source.slice(0, 3).toUpperCase()
}

/** What a folder is, given what its parent is. */
export function classify(name: string, parent: NodeKind, generated: ReadonlySet<string>): NodeKind {
  if (generated.has(name)) return 'generated'
  if (TYPE_FOLDER.test(name)) return 'type'
  if (parent === 'type' && INSTANCE_NAME.test(name)) return 'instance'
  return 'folder'
}

/** The newest session bound to each folder, so a folder row can be its session. */
function currentByFolder(sessions: readonly SessionMeta[]): Map<string, SessionMeta> {
  const map = new Map<string, SessionMeta>()
  for (const meta of sessions) {
    const canonical = canonicalPath(meta.cwd)
    const seen = map.get(canonical)
    if (seen === undefined || seen.created < meta.created) map.set(canonical, meta)
  }
  return map
}

/**
 * One directory's entries worth showing: folders first, then files, each name-sorted.
 *
 * Folders first is what makes a tree navigable — the structure a person is walking stays together at
 * the top, and the leaves sit under it. Dot-entries and the two noise directories are not returned at
 * all, which is the same judgement the tree made when it showed folders only.
 *
 * A **symlink is what it resolves to**, as DSH lists one: `dsh-fs-local`'s `listDirectory` probes each child's resolved
 * target for its type and reports a size only for a regular file, so a linked folder lists as a folder and expands like
 * its target (`dsh-api-workspace-files`, `list` follows a final directory link). A directory entry's own type does not
 * follow the link, which is why this asks `stat`: measured, a link to a folder was a 0-byte file that could not be
 * opened. A link that resolves to nothing stays a 0-byte leaf. `link` tells the caller to keep the row at the link's own
 * path rather than its target's.
 */
function entries(dir: string): { readonly name: string; readonly directory: boolean; readonly bytes: number; readonly link: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !PLUMBING.has(entry.name))
      .map((entry) => {
        if (!entry.isSymbolicLink()) {
          return { name: entry.name, directory: entry.isDirectory(), bytes: entry.isFile() ? sizeOf(join(dir, entry.name)) : 0, link: false }
        }
        const target = statOf(join(dir, entry.name))
        return {
          name: entry.name,
          directory: target?.isDirectory() === true,
          bytes: target?.isFile() === true ? target.size : 0,
          link: true,
        }
      })
      .sort((left, right) => (left.directory === right.directory ? collator.compare(left.name, right.name) : left.directory ? -1 : 1))
  } catch {
    // A folder that cannot be read is a folder with nothing to show, not a failure of the tree.
    return []
  }
}

/** What a path resolves to, following links, or `undefined` when it resolves to nothing. */
function statOf(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/** A file's size, or 0 when it cannot be read — an unreadable file is still a row. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** How much of a file the reader will hand back, unless a caller says otherwise. */
export const FILE_LIMIT_BYTES = 256 * 1024

/** A file, as the right panel shows it. */
export interface FileReading {
  readonly path: string
  readonly name: string
  readonly bytes: number
  readonly lines: number
  readonly text: string
  /** The file is longer than the limit, so `text` is its beginning and not all of it: the complete characters before the limit. */
  readonly truncated: boolean
}

/**
 * Read a text file for the viewer, refusing what a viewer cannot show.
 *
 * Three refusals, and each is a sentence a person can act on rather than a silent empty panel: a
 * directory or a missing path is not a file, a binary is not text, and a file longer than the limit
 * is **truncated and says so** instead of being refused — a big log is exactly the thing a reader
 * opens.
 *
 * This is a **view**, not a way around the sandbox: the caller decides which paths are readable
 * (both do it by asking the workspace service whether the path is under a registered root, on the
 * canonical path, so a symlink pointing outside is refused), and a tool that writes or reads on a
 * model's behalf still goes through the sandbox and the approval policy.
 */
export function readFileText(path: string, options: { readonly limit?: number } = {}): FileReading {
  const canonical = canonicalPath(path)
  const limit = options.limit ?? FILE_LIMIT_BYTES
  let stats
  try {
    stats = statSync(canonical)
  } catch {
    throw new Error(`${canonical} is not a file`)
  }
  if (!stats.isFile()) throw new Error(`${canonical} is not a file`)

  const whole = readFileSync(canonical)
  const slice = whole.subarray(0, limit)
  if (slice.includes(0)) throw new Error(`${canonical} looks like a binary file, so it has no text to show`)
  const truncated = whole.length > slice.length
  const text = decodeUtf8(slice, truncated)
  if (text === undefined) throw new Error(`${canonical} is not UTF-8 text, so it has no text to show`)
  return {
    path: canonical,
    name: basename(canonical),
    bytes: stats.size,
    lines: text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
    text,
    truncated,
  }
}

/**
 * The slice's text, or `undefined` when its bytes are not UTF-8 (issue #78).
 *
 * Decoded **strictly**: a literal U+FFFD in the file is a character like any other, and only bytes that are not UTF-8
 * are refused — DSH's reader decodes with `TextDecoder('utf-8', { fatal: true })` (dsh-fs-local lib/index.js:454). When
 * the limit cut the file, its last character may be cut too, so the slice is decoded in **stream** mode, which holds
 * back a trailing sequence that is incomplete but valid so far and throws on any byte that begins no character — DSH
 * decodes its chunks the same way (:342), and it is the Rust port's `Utf8Error::error_len() == None` at the end. The
 * text is then the complete characters before the cut. A file that is not cut has no such excuse, so a final incomplete
 * character is refused. `ignoreBOM` keeps a leading BOM in the text, as `Buffer.toString` did and the Rust port does.
 */
function decodeUtf8(slice: Uint8Array, truncated: boolean): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice, { stream: truncated })
  } catch {
    return undefined
  }
}

interface Context {
  readonly roots: readonly TreeRoot[]
  readonly byPath: Map<string, TreeRoot>
  readonly generated: ReadonlySet<string>
  readonly sessions: Map<string, SessionMeta>
  /** The same store records, by session id, for the sessions a `_sessions_` instance names. */
  readonly byId: Map<string, SessionMeta>
  /** Which archived sessions are drawn. */
  readonly archived: 'hide' | 'show' | 'only'
  /** The nearest root strictly above a path, or `undefined` when there is none. */
  ownerOf(path: string): TreeRoot | undefined
}

function buildContext(input: TreeInput): Context {
  const roots = input.roots.map((root) => ({
    path: canonicalPath(root.path),
    title: root.title,
    ...(root.origin !== undefined ? { origin: root.origin } : {}),
  }))
  const byPath = new Map(roots.map((root) => [root.path, root]))
  const ordered = [...roots].sort((left, right) => depthOf(right.path) - depthOf(left.path))
  return {
    roots,
    byPath,
    generated: new Set(input.generated ?? []),
    sessions: currentByFolder(input.sessions),
    byId: new Map(input.sessions.map((session) => [session.id, session])),
    archived: input.archived === 'show' || input.archived === 'only' ? input.archived : 'hide',
    ownerOf: (path) => ordered.find((root) => root.path !== path && isUnder(root.path, path)),
  }
}

function row(
  path: string,
  kind: NodeKind,
  label: string,
  context: Context,
  /** `true` when the caller knows this folder's session is shown somewhere else — on its own session row. */
  suppressSession = false,
): Omit<TreeNode, 'children'> {
  /**
   * A session **started in** a folder is shown on that folder when the conventions put a `_type_` boundary
   * around it — an instance. Two additions since the same day: a `_sessions_` instance is hoisted into its
   * branch as a `session` row and that row carries its own conversation (see `sessionOf`), and a session
   * started at a workspace root appears under the root, because the owner's rule is that a branch shows its
   * sessions and a root is a branch.
   */
  const meta = kind === 'instance' && !suppressSession ? context.sessions.get(path) : undefined
  return {
    path,
    kind,
    label,
    badge: kind === 'type' ? badgeFor(label) : null,
    session:
      meta === undefined
        ? null
        : {
            id: meta.id,
            turns: meta.turns,
            created: meta.created,
            ...(meta.title !== undefined ? { title: meta.title } : {}),
            ...(meta.updated !== undefined ? { updated: meta.updated } : {}),
          },
  }
}

/**
 * The session ids a folder's `_sessions_` folder names in its definitions.
 *
 * A conversation can be bound to a folder by its `cwd` **and** captured as an instance under that folder's
 * `_sessions_`, and then the tree would show one conversation twice — measured: clicking the session row
 * moved the mark to the instance row, because both rows claimed the same session id and the instance came
 * first. The instance's own binding is therefore dropped when a definition under it names the same session:
 * the conversation is shown once, on the row that is the session.
 */
function capturedIn(dir: string): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const entry of entries(join(dir, SESSIONS_FOLDER))) {
    if (!entry.directory) continue
    const definition = readSessionDefinition(join(dir, SESSIONS_FOLDER, entry.name))
    if (definition !== null) ids.add(definition.id)
  }
  return ids
}

/**
 * The session a `_sessions_` instance stands for.
 *
 * A **hoisted** session node is not bound to its folder the way an instance is bound to its `cwd`: the folder
 * named here is the session's *definition*, and the session it defines is named inside it. So the node says
 * which conversation it is — its id, and the store's turn count and title when the store still holds it — and
 * a click on the row can open that conversation rather than only expand a folder. Measured reason for this:
 * a row that named no session looked exactly like a row that named one, and clicking it did nothing.
 */
function sessionOf(dir: string, context: Context): TreeNode['session'] {
  const definition = readSessionDefinition(dir)
  if (definition === null) return null
  const meta = context.byId.get(definition.id)
  const title = meta?.title ?? definition.title
  const updated = meta?.updated
  return {
    id: definition.id,
    turns: meta?.turns ?? 0,
    created: meta?.created ?? definition.createdAt,
    ...(title !== undefined ? { title } : {}),
    ...(updated !== undefined ? { updated } : {}),
  }
}

/** The direct children of a folder: its subfolders, its files, or a registered root among them. */
function childrenOf(dir: string, kind: NodeKind, context: Context): TreeNode[] {
  const sessions: TreeNode[] = []
  const rest: TreeNode[] = []
  /**
   * Asked for **by name**, the sessions folder answers with sessions rather than with instances: the
   * classification a child would normally get comes from its parent's kind, and this parent's meaning is
   * "the sessions of the branch above me".
   */
  const parentIsSessions = basename(dir) === SESSIONS_FOLDER

  for (const entry of entries(dir)) {
    /**
     * A link's row stays at the **link's own path**, DSH's rule (a child's path is the listed directory's joined with its
     * name, `dsh-api-workspace-files` types.d.ts). Canonicalising it put the row at its target's path, which the target's
     * own row already holds, so two rows shared one path. Asking for the link's path lists its target: `tree` resolves it,
     * and the caller's containment check refuses a link that leads outside every root.
     */
    const path = entry.link ? join(dir, entry.name) : canonicalPath(join(dir, entry.name))

    /**
     * The sessions folder is **not a node**; the sessions inside it are this branch's own.
     *
     * The owner's rule of 2026-10-11: `_sessions_` is a filing folder, not something a person navigates
     * — a branch's sessions belong to the branch, so each of them is shown directly under it and **first**,
     * before the folders and files that live there. A folder named `_sessions_` that holds no instance
     * therefore leaves no trace at all, which is right: there is nothing to show.
     */
    if (entry.directory && entry.name === SESSIONS_FOLDER) {
      /**
       * **Newest first.** The names are chronological by construction (`session-<yyyymmdd>-<hhmm>`), so a
       * descending name order is a descending time order — and the session a person just started is the one
       * they are looking for, which is what "at the top of the branch" means once the group is there.
       */
      /**
       * **Pinned first, then newest.** A pin is a statement that this session matters more than its neighbours,
       * so it outranks the clock; within each group the names are chronological by construction, so a descending
       * name order is a descending time order.
       */
      const drawn = entries(path).filter((entry) => entry.directory)
      const flagged = drawn.map((entry) => {
        const dir = canonicalPath(join(path, entry.name))
        const definition = readSessionDefinition(dir)
        const meta = definition === null ? undefined : context.byId.get(definition.id)
        /**
         * The flags come from the **store** and nowhere else. Pinning and archiving are this reader's state,
         * not facts about the run: wrote them into the definition and the repository's record starts claiming
         * a session is archived, while the tree and the store can disagree — measured, two sessions were
         * flagged in their definitions and vanished from the tree because of it.
         */
        return {
          entry,
          dir,
          definition,
          pinned: meta?.pinned === true,
          ...(meta?.pinnedAt !== undefined ? { pinnedAt: meta.pinnedAt } : {}),
          ...(meta?.updated !== undefined ? { updated: meta.updated } : {}),
          archived: meta?.archived === true,
        }
      })
      const visible = flagged.filter((one) =>
        context.archived === 'show' ? true : context.archived === 'only' ? one.archived : !one.archived,
      )
      for (const one of visible.sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
        /**
         * Among pinned sessions the **most recently pinned** comes first — DSH prepends each pin to a registry list, so a
         * timestamp descending is the same order. Where this UI sorted by name before, two sessions pinned minutes apart
         * sorted as if the pin had no history.
         */
        if (left.pinnedAt !== undefined && right.pinnedAt !== undefined && left.pinnedAt !== right.pinnedAt) {
          return String(right.pinnedAt).localeCompare(String(left.pinnedAt))
        }
        /** A pinned record without a time is an older one; it sorts after a timed pin rather than crashing the order. */
        if (left.pinnedAt !== undefined && right.pinnedAt === undefined) return -1
        if (left.pinnedAt === undefined && right.pinnedAt !== undefined) return 1
        /**
         * Otherwise **last updated first**, which is the reference's list order: a conversation that just received a message
         * moves to the top of its folder. The old comparator used the definition's clock name, so writing to an old session
         * never moved it — measured by the owner as "the list is regularly sorted, but not by what I did last".
         */
        const leftUpdated = left.updated ?? left.definition?.createdAt
        const rightUpdated = right.updated ?? right.definition?.createdAt
        if (leftUpdated !== undefined && rightUpdated !== undefined && leftUpdated !== rightUpdated) {
          return String(rightUpdated).localeCompare(String(leftUpdated))
        }
        return collator.compare(right.entry.name, left.entry.name)
      })) {
        const node = row(one.dir, 'session', one.entry.name, context)
        /**
         * A session is a **leaf**, and the files in its definition folder are deliberately not shown — the
         * owner's rule of 2026-10-11: what a person wants from a session is the conversation and its
         * trajectory, which the right panel shows, rather than the `INDEX.md` and `session.json` that make
         * the folder. `children: []` is the leaf's answer ("asked for, and there is nothing to show"), as
         * opposed to the `null` of a folder nobody has opened yet.
         */
        sessions.push({
          ...node,
          session: sessionOf(one.dir, context),
          ...(one.pinned ? { pinned: true } : {}),
          ...(one.pinnedAt !== undefined ? { pinnedAt: one.pinnedAt } : {}),
          ...(one.archived ? { archived: true } : {}),
          children: [],
        })
      }
      continue
    }

    /**
     * A file is a leaf and says so: `children: []` — asked for and empty — rather than `null`, because
     * "not asked" would invite a client to look for children that cannot exist.
     */
    if (!entry.directory) {
      rest.push({ ...row(path, 'file', entry.name, context), children: [], bytes: entry.bytes })
      continue
    }
    const root = context.byPath.get(path)
    if (root !== undefined) {
      rest.push({ ...row(path, 'workspace', root.title, context), children: null })
      continue
    }
    const nodeKind = parentIsSessions ? 'session' : classify(entry.name, kind, context.generated)
    const own = context.sessions.get(path)
    rest.push({
      ...row(path, nodeKind, entry.name, context, own !== undefined && capturedIn(path).has(own.id)),
      children: null,
    })
  }

  return [...sessions, ...rest]
}

/**
 * What a folder is, worked out from the root above it rather than from its name alone.
 *
 * The walk is why an instance is only an instance inside a type folder, and why a type may appear at
 * any depth: each segment is classified against the one before it. A path that is not a directory is
 * a **file** whatever its name looks like, so a folder-name pattern never turns a file into a type.
 */
export function kindOf(path: string, input: TreeInput): NodeKind {
  const canonical = canonicalPath(path)
  if (!isDirectory(canonical)) return 'file'
  const context = buildContext(input)
  const self = context.byPath.get(canonical)
  if (self !== undefined) return 'workspace'
  const owner = context.ownerOf(canonical)
  if (owner === undefined) return 'folder'
  const relative = canonical.slice(owner.path.length).split(sep).filter(Boolean)
  let kind: NodeKind = 'workspace'
  let inSessions = false
  for (const segment of relative) {
    /**
     * Past `_sessions_` the next segment is a **session** rather than an instance of a type, because the
     * folder that would have said so is not drawn. Its own subfolders classify normally from there.
     */
    if (segment === SESSIONS_FOLDER) {
      inSessions = true
      continue
    }
    if (inSessions) {
      kind = 'session'
      inSessions = false
      continue
    }
    kind = classify(segment, kind, context.generated)
  }
  /** The path *is* the sessions folder: it is a type folder, and asking for it directly lists its sessions. */
  return inSessions ? 'type' : kind
}

/** Whether a path is a directory, for the two places that must not treat a file as a folder. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * One level of the tree: the roots when `path` is null, otherwise that folder and its children.
 *
 * A path outside every root is classified `folder` here; deciding that it is *refused* belongs to
 * the caller, which is the only layer that knows whether a refusal is an error (the CLI) or a `400`
 * (HTTP).
 */
export function tree(path: string | null, input: TreeInput): TreeNode {
  const context = buildContext(input)

  if (path === null || path === '') {
    const tops = context.roots.filter((root) => context.ownerOf(root.path) === undefined)
    const asNode = (root: TreeRoot): TreeNode => ({
      ...row(root.path, 'workspace', root.title, context),
      children: childrenOf(root.path, 'workspace', context),
    })
    return {
      path: '',
      kind: 'roots',
      label: 'workspaces',
      badge: null,
      session: null,
      children: tops.filter((root) => root.origin !== 'auto').map(asNode),
      adHoc: tops.filter((root) => root.origin === 'auto').map(asNode),
    }
  }

  const canonical = canonicalPath(path)
  if (!isDirectory(canonical)) {
    // Asking for a file answers with the file's own row, so a client that navigates by path never gets
    // a folder-shaped node for something that cannot hold children.
    return { ...row(canonical, 'file', basename(canonical), context), children: [], bytes: sizeOf(canonical) }
  }
  const root = context.byPath.get(canonical)
  const kind = root !== undefined ? 'workspace' : kindOf(canonical, input)
  const label = root !== undefined ? root.title : basename(canonical)
  return { ...row(canonical, kind, label, context), children: childrenOf(canonical, kind, context) }
}
