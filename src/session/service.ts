import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { canonicalPath } from '../paths.ts'
import { existingSessionNames, writeSessionDefinition, type SessionDefinition } from './definition.ts'
import type { Message } from '../llm/types.ts'

import { SessionStore, defaultSessionRoot, type RecordedMessage, type SessionHandle, type SessionId, type SessionMeta, type SurfaceState } from './store.ts'

export * from './store.ts'

export const name = 'session'

export const Config = Schema.object({
  /** Where sessions live. Defaults to `$HEDDLE_HOME/sessions`. */
  root: Schema.string().default(defaultSessionRoot()),
})

export interface Config {
  readonly root?: string
}

/**
 * The session service.
 *
 * A thin Cordis face over the store, so a consumer writes `ctx.session.turn(...)`
 * and never touches a path. The store itself stays a plain class with no Cordis
 * dependency, which is what lets it be tested without a context.
 */
/**
 * A session's name taken from its first message: one line, shortened at a word, no trailing punctuation.
 *
 * The same shape DSH shows in its session list. It is a *label*, so it may be lossy; the id stays the identity
 * and the full message stays in the log.
 */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length === 0) return ''
  const limit = 48
  if (line.length <= limit) return line.replace(/[.,;:!?]+$/, '')
  const cut = line.slice(0, limit)
  const at = cut.lastIndexOf(' ')
  return (at > limit / 2 ? cut.slice(0, at) : cut).replace(/[.,;:!?]+$/, '') + '…'
}

/**
 * A fork's name: DSH's `<title> (1)`, with the ordinal rising past whatever the store already holds.
 *
 * A pure function rather than a loop inside `fork`, because the rule is what a person reads and a fork that reused
 * an existing name would be a fork nobody could tell apart in a list.
 */
export function forkTitle(base: string, taken: readonly string[]): string {
  const trimmed = base.trim().length > 0 ? base.trim() : 'session'
  let ordinal = 1
  while (taken.includes(`${trimmed} (${ordinal})`)) ordinal += 1
  return `${trimmed} (${ordinal})`
}

export class SessionService extends Service {
  static readonly provide = 'session'

  readonly store: SessionStore

  constructor(
    ctx: Context,
    config: Config = {},
    options: { readonly onEvent?: (handle: SessionHandle, event: import('./store.ts').SessionEvent) => void } = {},
  ) {
    super(ctx, 'session')
    this.store = new SessionStore(config.root ?? defaultSessionRoot(), options)
  }

  /** Open the session a run continues, or start one. */
  start(options: { readonly resume?: SessionId; readonly cwd?: string; readonly endpoint?: string; readonly model?: string; readonly title?: string } = {}): SessionHandle {
    if (options.resume !== undefined) {
      const existing = this.store.open(options.resume)
      if (existing === null) throw new Error(`no session '${options.resume}' under ${this.store.root}`)
      return existing
    }
    return this.store.create({
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
    })
  }

  /**
   * Start a session bound to a folder **and write its definition into that folder**.
   *
   * The owner's ruling of 2026-10-11, and the reason this is one call rather than two: the log belongs to
   * the machine and the definition belongs to the folder, and a session created without the second is a
   * session nobody can find, review or commit. `fresh` is always true here — asking for a new session is
   * asking for a new one.
   */
  createAt(
    branch: string,
    options: { readonly title?: string; readonly endpoint?: string; readonly model?: string } = {},
  ): { readonly handle: SessionHandle; readonly definition: SessionDefinition } {
    const canonical = canonicalPath(branch)
    const taken = existingSessionNames(canonical)
    const handle = this.openAt(canonical, { fresh: true, ...options })
    const meta = this.list().find((entry) => entry.id === handle.id)
    const definition = writeSessionDefinition(handle, canonical, {
      createdAt: meta?.created ?? new Date().toISOString(),
      taken,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    })
    return { handle, definition }
  }

  /**
   * Fork a session: a new one that continues from where that one stood.
   *
   * DSH's behaviour, observed on 2026-10-17: the item acts on the session it belongs to, the fork is named
   * `<title> (1)` with a rising ordinal, it appears beside its parent, and the view **does not** navigate to it.
   * The folder keeps the conventions' instance naming rule — a title with spaces and brackets is a label, not
   * an instance name — so the identity is generated as for any other session while the title carries the name.
   */
  fork(id: SessionId): { readonly handle: SessionHandle; readonly definition: SessionDefinition } | null {
    const source = this.store.list().find((one) => one.id === id)
    if (source === undefined) return null
    const handle = this.store.fork(id)
    if (handle === null) return null
    const created = this.store.list().find((one) => one.id === handle.id)
    const base = source.title !== undefined && source.title.trim().length > 0 ? source.title.trim() : 'session'
    const title = forkTitle(base, this.store.list().map((one) => one.title ?? ''))
    this.store.rename(handle.id, title)
    const definition = writeSessionDefinition(handle, source.cwd, {
      createdAt: created?.created ?? new Date().toISOString(),
      title,
      taken: existingSessionNames(source.cwd),
      ...(source.endpoint !== undefined ? { endpoint: source.endpoint } : {}),
      ...(source.model !== undefined ? { model: source.model } : {}),
    })
    return { handle, definition }
  }

  /**
   * Record a user turn and return once it is on disk.
   *
   * The first message also **names** the session when nothing has named it yet. DSH does this — its list reads
   * `context-mgmt 4d`, not `session-20261017-1340` — and the reason is the same here: a clock name is an
   * identity, and a list of identities is a list nobody can scan. A title the person typed afterwards wins,
   * because this only fills a blank.
   */
  user(handle: SessionHandle, text: string, source?: unknown): void {
    this.store.message(handle, { role: 'user', content: [{ type: 'text', text }], ...(source !== undefined ? { source } : {}) })
    const meta = this.store.list().find((one) => one.id === handle.id)
    if (meta !== undefined && (meta.title === undefined || meta.title.trim().length === 0)) {
      const title = titleFrom(text)
      if (title.length > 0) this.store.rename(handle.id, title)
    }
  }

  /**
   * The folder's current session: the newest session whose working directory is exactly this folder.
   *
   * This is the whole of "one folder, one session". A folder's session is not a stored pointer but a
   * question with an answer — the newest log bound to that folder — so a session created by another
   * process, or by an older build, is the folder's session the moment it is the newest one there.
   * Sessions that are no longer current are still in the store, still listed, still readable by id;
   * they simply are not what the folder points at.
   */
  current(folder: string): SessionMeta | null {
    const canonical = canonicalPath(folder)
    return this.list().find((meta) => canonicalPath(meta.cwd) === canonical) ?? null
  }

  /**
   * Open the session **bound to a folder**, creating one when the folder has none.
   *
   * `fresh` starts a new session regardless of what the folder holds, which then becomes the
   * folder's current session — the `--new` path. The old one is untouched: nothing is rewritten, and
   * the folder simply points somewhere else afterwards.
   */
  openAt(
    folder: string,
    options: { readonly fresh?: boolean; readonly endpoint?: string; readonly model?: string; readonly title?: string } = {},
  ): SessionHandle {
    const canonical = canonicalPath(folder)
    if (options.fresh !== true) {
      const existing = this.current(canonical)
      if (existing !== null) {
        const handle = this.store.open(existing.id)
        if (handle !== null) return handle
      }
    }
    return this.store.create({
      cwd: canonical,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
    })
  }

  /** The messages a resumed session would send, which is what "carries" means. */
  messages(handle: SessionHandle): readonly RecordedMessage[] {
    return this.store.messages(handle)
  }

  /**
   * The surface: the positional view a request is derived from.
   *
   * Exposed because two things outside the store need it and neither may re-implement the fold:
   * compaction, which selects a span of positions to shadow, and a check, which judges that a
   * rewrite landed without erasing the log.
   */
  surface(handle: SessionHandle): SurfaceState {
    return this.store.surface(handle)
  }

  /** One node's derived message, or null when the node produces none. */
  node(handle: SessionHandle, seq: number): Message | null {
    return this.store.deriveNode(handle, seq)
  }

  /** What has already happened, for a caller that wants to show it. */
  events(handle: SessionHandle) {
    return this.store.read(handle)
  }

  /** Every session, newest first. */
  list(): readonly SessionMeta[] {
    return this.store.list()
  }

  /** Retitle a session; the log is untouched and the meta record is the only thing rewritten. */
  rename(id: SessionId, title: string): SessionMeta | null {
    return this.store.rename(id, title)
  }

  /** Pin, unpin, archive or unarchive a session — the state behind a row's menu. */
  flags(id: SessionId, patch: { readonly pinned?: boolean; readonly archived?: boolean }): SessionMeta | null {
    return this.store.flags(id, patch)
  }

  /**
   * Switch a session onto an endpoint, replacing any model override it carried.
   *
   * Exposed on the service rather than read from `store` by the route, because the store is the layer a
   * caller may not touch and the switcher is an ordinary caller. The route validates the name against the
   * model service before it lands here; this records the decision the session made.
   */
  setModel(id: SessionId, selection: { readonly endpoint: string; readonly model?: string }): SessionMeta | null {
    return this.store.setModel(id, selection)
  }

  /** The last complete answer, which is what a transcript read returns. */
  lastAnswer(handle: SessionHandle): string {
    return this.store.lastAnswer(handle)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['session']`. */
    session: SessionService
  }
}

/** The session plugin: one service, and the store under it. */
export default function session(ctx: Context, config: Config = {}): void {
  ctx.set('session', new SessionService(ctx, config))
}
