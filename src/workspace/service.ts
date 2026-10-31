import { Context, Service } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

import { canonicalPath, depthOf, isUnder } from '../paths.ts'
import type { SessionMeta } from '../session/store.ts'

/**
 * Workspaces: a **target folder**, and the record that says it is one.
 *
 * Modelled on DSH's `dsh-workspace` with one deliberate divergence, and the divergence is the
 * owner's decision of 2026-10-11 (stated in full in `SESSION_TREE.md`):
 *
 * - **A workspace is both a record and a folder.** The record carries
 *   `{ id, path, title, createdAt, updatedAt }`; the folder is the path. Neither alone is a
 *   workspace. The path is the *root* — the target folder — and a session bound to any folder at or
 *   below it is a member.
 * - **Association is containment, compared by path segment.** DSH's rule is equality: a session
 *   belongs to the workspace whose path equals its working directory, so a subdirectory becomes a
 *   workspace of its own. Heddle's is containment, because its navigation is a tree of *folders*
 *   rather than of workspaces, and every folder that held a conversation would otherwise become a
 *   registration. `/a/b-sibling` is still not inside `/a/b`: the comparison is by segment, never by
 *   string.
 * - **The nearest root owns a session.** Roots may nest — `~/reflection` and
 *   `~/reflection/_projects_/x` can both be registered — and the deepest one above a folder is the
 *   one that accounts for it. DSH resolves the same way for display (`owningParentFolder`).
 * - **Order lives in an array, not in a field on the record.** The workspace list is one ordered
 *   array, so a new root is a prepend rather than a rewrite of every neighbour.
 *
 * The simplification DSH does not make: the record stores **no session account**. A session's
 * `cwd` already says which folder it is bound to, and membership is the containment rule applied to
 * it, so `sessionIds` was a second statement of one fact — and, worse, a statement the folder tree
 * cannot be built from. It is derived on every read instead. A version-1 file that still carries
 * the field is read without it and written back without it.
 */

export interface WorkspaceRecord {
  readonly id: string
  /** Canonical absolute path of the target folder. The root, and the association key. */
  readonly path: string
  readonly title: string
  /**
   * How this root came to exist, which is what tells a chosen folder from an adopted one.
   *
   * `added` is a folder a person registered — by `workspace add`, by the Web UI's button, or by
   * promoting an adopted one. `auto` is a folder a session was found in and `bootstrap` or
   * `ensureOwner` adopted, because "every session has a root" is what keeps the tree total. The
   * distinction is a **view**: the tree lists what a person chose, and the sessions of adopted
   * folders are listed apart, as ad-hoc work rather than as a project.
   *
   * Absent means `added`: a record written before this field existed should stay where it was
   * already being shown rather than silently moving out of the tree.
   */
  readonly origin?: 'added' | 'auto'
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkspaceStoreShape {
  readonly version: number
  /** Workspace ids in the collection's own order. */
  readonly workspaceIds: readonly string[]
  readonly workspaces: Record<string, WorkspaceRecord>
}

/**
 * A rename to a name another workspace already carries — DSH's `workspace/name-conflict`, which the route answers
 * `409`. The message is DSH's own sentence, so the page can show it as it comes.
 */
export class WorkspaceNameConflict extends Error {
  readonly code = 'workspace/name-conflict'
  readonly title: string
  constructor(title: string) {
    super(`A workspace named “${title}” already exists.`)
    this.title = title
  }
}

/**
 * A reorder naming a workspace that is not in the order — DSH's `WorkspaceOrderInvalidError` (dsh-workspace
 * lib/index.js:333-344), with its sentence. The route answers it `404` with DSH's `workspace/not-found`.
 */
export class WorkspaceOrderInvalid extends Error {
  readonly code = 'workspace/not-found'
  readonly workspaceId: string
  constructor(workspaceId: string) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.workspaceId = workspaceId
  }
}

/** What `add` reports: the record, and whether this call is what created it. */
export interface WorkspaceAddition {
  readonly record: WorkspaceRecord
  readonly created: boolean
}

/** Where the record lives. One file, outside every repository. */
export function defaultWorkspaceFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'workspaces.json')
}

export const Config = Schema.object({
  /** Where the workspace record is kept. */
  file: Schema.string().default(defaultWorkspaceFile()),
  /**
   * Folder names a tool writes.
   *
   * The folder tree names these rather than pretending they are content, and the names come from
   * configuration because nothing on disk distinguishes generated from authored — the same reason
   * the conventions linter takes `--generated <path>`.
   */
  generated: Schema.array(Schema.string()).default([]),
})

export interface Config {
  readonly file?: string
  readonly generated?: readonly string[]
}

/**
 * The workspace service.
 *
 * Every read reconciles the record with the sessions that exist, which is what makes the model
 * self-healing: a session whose folder has no root above it gets one the moment it is looked at, so
 * the record is derived from what exists rather than maintained by hand.
 */
export class WorkspaceService extends Service {
  static readonly provide = 'workspace'

  readonly file: string
  /** Folder names the tree should call generated. */
  readonly generated: readonly string[]

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspace')
    this.file = (config.file ?? defaultWorkspaceFile()).startsWith('~')
      ? join(homedir(), (config.file ?? '').slice(1))
      : (config.file ?? defaultWorkspaceFile())
    this.generated = config.generated ?? []
  }

  /** The whole record, read from disk each time rather than cached. */
  read(): WorkspaceStoreShape {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as {
        version?: number
        workspaceIds?: string[]
        workspaces?: Record<string, Partial<WorkspaceRecord> & { sessionIds?: unknown }>
      }
      const workspaces: Record<string, WorkspaceRecord> = {}
      for (const [id, record] of Object.entries(parsed.workspaces ?? {})) {
        if (typeof record?.path !== 'string' || typeof record?.title !== 'string') continue
        /**
         * Rebuilt field by field rather than spread, so a version-1 file's `sessionIds` is dropped
         * on the way in as well as on the way out. A spread would carry it forward forever.
         */
        workspaces[id] = {
          id: typeof record.id === 'string' ? record.id : id,
          path: record.path,
          title: record.title,
          origin: record.origin === 'auto' ? 'auto' : 'added',
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
          updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        }
      }
      return { version: 3, workspaceIds: parsed.workspaceIds ?? [], workspaces }
    } catch {
      return { version: 3, workspaceIds: [], workspaces: {} }
    }
  }

  private write(shape: WorkspaceStoreShape): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify({ ...shape, version: 3 }, null, 2)}\n`)
  }

  /** Every workspace, in the collection's order. */
  list(): readonly WorkspaceRecord[] {
    const shape = this.read()
    return shape.workspaceIds.map((id) => shape.workspaces[id]).filter((record): record is WorkspaceRecord => record !== undefined)
  }

  /** One workspace by path, creating the record when it does not exist yet. */
  ensure(path: string, title?: string, options: { readonly origin?: 'added' | 'auto' } = {}): WorkspaceRecord {
    const canonical = canonicalPath(path)
    const shape = this.read()
    const existing = Object.values(shape.workspaces).find((record) => record.path === canonical)
    if (existing !== undefined) {
      /**
       * Registering an adopted folder **promotes** it rather than duplicating it.
       *
       * This is what makes the ad-hoc group a staging area: a folder that was adopted because a
       * session ran in it moves into the tree the moment a person says it is a project, and its
       * sessions come with it because membership was always by path.
       */
      if (options.origin === 'added' && existing.origin !== 'added') {
        const promoted: WorkspaceRecord = { ...existing, origin: 'added', updatedAt: new Date().toISOString() }
        shape.workspaces[existing.id] = promoted
        this.write(shape)
        return promoted
      }
      return existing
    }

    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      id: randomUUID(),
      path: canonical,
      title: title ?? canonical.split('/').filter(Boolean).pop() ?? canonical,
      origin: options.origin ?? 'added',
      createdAt: now,
      updatedAt: now,
    }
    shape.workspaces[record.id] = record
    // Newest first, which is how DSH orders its workspace list.
    this.write({ ...shape, workspaceIds: [record.id, ...shape.workspaceIds] })
    return record
  }

  /** Register a target folder, reporting whether this call is what created the record. */
  add(path: string, title?: string): WorkspaceAddition {
    const before = this.find(path)
    const record = this.ensure(path, title, { origin: 'added' })
    return { record, created: before === undefined }
  }

  /**
   * Unregister a root, and say what happened to the sessions that were under it.
   *
   * Removing a root is not the same as forgetting one: `bootstrap` attaches every session to the
   * nearest root above its folder and **creates a root where there is none**, so a root removed while
   * sessions still live under it comes back on the next run. A button that reports success and is
   * undone a minute later is worse than one that refuses, so the rule is:
   *
   * - nothing under it → removed;
   * - sessions under it, and another root above it → removed, and its sessions are adopted by that
   *   root, which is durable because `owner()` resolves to the ancestor afterwards;
   * - sessions under it, and nothing above it → refused, unless `force`, which removes it and leaves
   *   those sessions to be re-registered by the next run.
   */
  remove(
    idOrPath: string,
    options: { readonly all?: readonly SessionMeta[]; readonly force?: boolean } = {},
  ): { readonly removed: WorkspaceRecord; readonly ownedSessions: number; readonly adoptedBy?: string } {
    const shape = this.read()
    const record = this.find(idOrPath)
    if (record === undefined) throw new Error(`no workspace '${idOrPath}'`)

    const owned = this.sessions(record, options.all ?? [])
    const others = Object.values(shape.workspaces).filter((entry) => entry.id !== record.id)
    const parent = this.owner(dirname(record.path), others)
    if (owned.length > 0 && parent === undefined && options.force !== true) {
      throw new Error(
        `workspace '${record.title}' still holds ${owned.length} session(s) and no root above it, so removing it would only be undone on the next run; remove those sessions, register a root above '${record.path}', or force it`,
      )
    }

    delete shape.workspaces[record.id]
    this.write({ ...shape, workspaceIds: shape.workspaceIds.filter((id) => id !== record.id) })
    return { removed: record, ownedSessions: owned.length, ...(parent !== undefined ? { adoptedBy: parent.title } : {}) }
  }

  /** One workspace by id or by path. */
  find(idOrPath: string): WorkspaceRecord | undefined {
    const shape = this.read()
    if (shape.workspaces[idOrPath] !== undefined) return shape.workspaces[idOrPath]
    const canonical = canonicalPath(idOrPath)
    return Object.values(shape.workspaces).find((record) => record.path === canonical)
  }

  /**
   * Retitle a root, by id or by path.
   *
   * The title is a label a person reads and nothing an association is made of — the path is, and a
   * rename never touches it. An empty title is refused rather than saved, because a nameless row in a
   * tree is a row a person cannot find again.
   */
  rename(idOrPath: string, title: string): WorkspaceRecord | undefined {
    const trimmed = title.trim()
    if (trimmed.length === 0) throw new Error('a workspace needs a name')
    const shape = this.read()
    const record = this.find(idOrPath)
    if (record === undefined) return undefined
    /**
     * DSH's two rename rules: confirming the name a workspace already has changes nothing, and a name another
     * workspace a person chose already carries is refused (`workspace/name-conflict`). Adopted (`auto`) roots are not
     * counted: the tree never draws them as workspaces, so a clash with one would be a refusal nobody could see the
     * reason for.
     */
    if (trimmed === record.title) return record
    const clash = Object.values(shape.workspaces).find((entry) => entry.id !== record.id && entry.origin !== 'auto' && entry.title === trimmed)
    if (clash !== undefined) throw new WorkspaceNameConflict(trimmed)
    const updated: WorkspaceRecord = { ...record, title: trimmed, updatedAt: new Date().toISOString() }
    shape.workspaces[record.id] = updated
    this.write(shape)
    return updated
  }

  /**
   * Move one workspace within the stored order, DOM-`insertBefore`-like — DSH's `workspace/insertBefore`
   * (dsh-workspace lib/index.js:473-499).
   *
   * With an anchor the workspace lands just before it; without one it goes to the end. Both are named by id or by
   * path, as the other routes name a workspace, and either missing from the order is {@link WorkspaceOrderInvalid}.
   * Naming itself as its anchor, or a move that changes nothing, writes nothing. The order is the same
   * `workspaceIds` array a new root is prepended to, so the file keeps its shape and the other build reads it as
   * before. The order is registry-wide and flat: nesting is drawn from paths, so the page only offers a drop among a
   * workspace's siblings, as DSH's does. Answers the complete order, as DSH's does.
   */
  insertBefore(idOrPath: string, beforeIdOrPath?: string): readonly string[] {
    const shape = this.read()
    const listed = (key: string): string => {
      const record = this.find(key)
      if (record === undefined || !shape.workspaceIds.includes(record.id)) throw new WorkspaceOrderInvalid(key)
      return record.id
    }
    const id = listed(idOrPath)
    const before = beforeIdOrPath === undefined ? undefined : listed(beforeIdOrPath)
    if (before === id) return shape.workspaceIds
    const without = shape.workspaceIds.filter((each) => each !== id)
    const at = before === undefined ? without.length : without.indexOf(before)
    const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
    if (workspaceIds.length === shape.workspaceIds.length && workspaceIds.every((each, index) => each === shape.workspaceIds[index])) {
      return shape.workspaceIds
    }
    this.write({ ...shape, workspaceIds })
    return workspaceIds
  }

  /**
   * The root that owns a folder: the **nearest** registered root at or above it.
   *
   * `undefined` when no root is above the folder, which is a fact rather than a failure — the caller
   * decides whether to register one (see {@link ensureOwner}).
   */
  owner(path: string, records: readonly WorkspaceRecord[] = this.list()): WorkspaceRecord | undefined {
    const canonical = canonicalPath(path)
    return [...records]
      .sort((left, right) => depthOf(right.path) - depthOf(left.path))
      .find((record) => isUnder(record.path, canonical))
  }

  /**
   * The sessions a root accounts for: those bound to a folder at or below it, minus the ones a
   * **nearer** root owns.
   *
   * Derived, never stored. `all` is newest first, as the store returns it, and the order is kept so
   * a listing reads newest-first within a workspace too.
   */
  sessions(record: WorkspaceRecord, all: readonly SessionMeta[]): readonly SessionMeta[] {
    const records = this.list()
    return all.filter((meta) => {
      const canonical = canonicalPath(meta.cwd)
      if (!isUnder(record.path, canonical)) return false
      return this.owner(canonical, records)?.id === record.id
    })
  }

  /** Every workspace with its parent and its sessions — what `GET /api/workspaces` answers. See {@link workspaceViews}. */
  views(all: readonly SessionMeta[]): WorkspaceView[] {
    return workspaceViews(this.list(), all)
  }

  /**
   * The root that owns a folder, registering the folder itself when nothing above it does.
   *
   * This is what keeps "a session always has a workspace" true without a hand-maintained record: the
   * run that creates a session in an unregistered folder registers that folder as a root.
   */
  ensureOwner(path: string): WorkspaceRecord {
    const canonical = canonicalPath(path)
    return this.owner(canonical) ?? this.ensure(canonical, undefined, { origin: 'auto' })
  }

  /**
   * Group every session under the nearest root above it, creating a root where there is none.
   *
   * DSH does the same at startup by grouping stored headers by canonical cwd. Idempotent: a session
   * already accounted for creates nothing.
   */
  bootstrap(all: readonly SessionMeta[]): { readonly workspaces: number; readonly attached: number; readonly created: number } {
    let attached = 0
    let created = 0
    for (const meta of all) {
      const canonical = canonicalPath(meta.cwd)
      if (this.owner(canonical) === undefined) {
        this.ensure(canonical, undefined, { origin: 'auto' })
        created += 1
      }
      attached += 1
    }
    return { workspaces: this.list().length, attached, created }
  }
}

/**
 * One workspace as the Web UI's workspace tree reads it — DSH's `WorkspaceView`, derived by heddle's rules.
 *
 * `parent` is the nearest registered root **strictly above** this one (DSH's `owningParentFolder`), which is what
 * nests one workspace under another in the tree; `sessionIds` is the membership DSH's Host supplies with each
 * workspace, here the sessions whose **nearest** root this is. Neither is stored: both are read from the record and
 * the store on every call, the same way `owner()` and `sessions()` are.
 */
export interface WorkspaceView {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly origin: 'added' | 'auto'
  readonly parent: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
}

/**
 * Every workspace with its parent and its sessions, in the record's order.
 *
 * Pure, so it is judged without a store. `records` are already canonical (the record stores canonical paths); a
 * session's `cwd` is canonicalised here, as `sessions()` does. `all` keeps its order, so `sessionIds` read newest first
 * when the store's list does. Archived and subagent sessions are included: hiding them is the reader's choice.
 */
export function workspaceViews(records: readonly WorkspaceRecord[], all: readonly SessionMeta[]): WorkspaceView[] {
  const nearestFirst = [...records].sort((left, right) => depthOf(right.path) - depthOf(left.path))
  const owners = new Map<string, string[]>()
  for (const meta of all) {
    const canonical = canonicalPath(meta.cwd)
    const owner = nearestFirst.find((record) => isUnder(record.path, canonical))
    if (owner === undefined) continue
    const list = owners.get(owner.id) ?? []
    list.push(meta.id)
    owners.set(owner.id, list)
  }
  return records.map((record) => {
    const parent = nearestFirst.find((other) => other.id !== record.id && other.path !== record.path && isUnder(other.path, record.path))
    return {
      id: record.id,
      path: record.path,
      title: record.title,
      origin: record.origin === 'auto' ? 'auto' : 'added',
      parent: parent === undefined ? null : parent.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      sessionIds: owners.get(record.id) ?? [],
    }
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin. */
    workspace: WorkspaceService
  }
}

/** The workspace plugin: it needs the session store to bootstrap from. */
export default class WorkspacePlugin extends WorkspaceService {
  static readonly Config = Config

  static readonly inject = ['session']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, config)
    /**
     * The record is reconciled with the sessions that exist **on every load**, not only on the
     * first.
     *
     * Measured, and it is what "grouped under a folder" means for a real user: a session recorded by
     * a run that started before its workspace existed — or by another process, or before this
     * machine had a record at all — was invisible to `heddle workspaces` forever, because the
     * bootstrap only ran when the file was absent. Reconciling each time is idempotent, adopts what
     * is missing, and keeps the record derived from the store rather than maintained by hand.
     */
    this.bootstrap(ctx.session.list())
  }
}
