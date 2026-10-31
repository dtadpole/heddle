import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'

import { canonicalPath } from '../paths.ts'
import { isSandboxMode, type SandboxMode } from '../sandbox/service.ts'
import { existingSessionNames, writeSessionDefinition, type SessionDefinition } from './definition.ts'
import { textOf, type ContentPart, type Message } from '../llm/types.ts'
import { MODE_EVENT, effectiveMode as foldEffectiveMode, recordedMode as foldRecordedMode } from './mode.ts'

import { inheritsAnswer, SessionStore, defaultSessionRoot, type RecordedMessage, type SessionEvent, type SessionHandle, type SessionId, type SessionMeta, type SurfaceState } from './store.ts'

export * from './store.ts'
export * from './mode.ts'

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
  /**
   * DSH's `increasedForkTitle`, read from its session controller: a title that already ends in `(n)` — ASCII or the
   * full-width `（n）` a Chinese title uses — is incremented **in place**, and only a title without a suffix gains ` (1)`.
   * The earlier version here always appended, so forking a fork produced `x (1) (1)` where the reference produces `x (2)`.
   */
  const ascii = /^(.*?)\((\d+)\)$/u.exec(trimmed)
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(trimmed)
  const match = ascii ?? fullWidth
  const prefix = match?.[1] ?? trimmed
  let ordinal = match?.[2] === undefined ? 1 : Number(match[2]) + 1
  /** The reference does not look past the suffix; the store's titles are a list, so a taken name steps past it rather than colliding. */
  const format = (value: number) => (ascii !== null ? `${prefix}(${value})` : fullWidth !== null ? `${prefix}（${value}）` : `${prefix} (${value})`)
  while (taken.includes(format(ordinal))) ordinal += 1
  return format(ordinal)
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

  /**
   * The folder this session belongs to, not the directory its caller was launched in.
   * Read this handle's metadata directly so another session in the same store cannot supply the answer.
   * A legacy record with no readable folder leaves the caller its explicit fallback.
   */
  folder(handle: SessionHandle): string | undefined {
    try {
      const meta: unknown = JSON.parse(readFileSync(handle.meta, 'utf8'))
      if (typeof meta !== 'object' || meta === null || !('cwd' in meta)) return undefined
      return typeof meta.cwd === 'string' && meta.cwd.trim().length > 0 ? meta.cwd : undefined
    } catch {
      return undefined
    }
  }

  /** Open the session a run continues, or start one. */
  start(options: {
    readonly resume?: SessionId
    readonly cwd?: string
    readonly endpoint?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly title?: string
  } = {}): SessionHandle {
    if (options.resume !== undefined) {
      const existing = this.store.open(options.resume)
      if (existing === null) throw new Error(`no session '${options.resume}' under ${this.store.root}`)
      return existing
    }
    return this.store.create({
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
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
    options: { readonly title?: string; readonly endpoint?: string; readonly model?: string; readonly reasoningEffort?: string } = {},
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
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
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
  fork(id: SessionId): { readonly handle: SessionHandle; readonly definition: SessionDefinition } | null | { readonly error: 'unavailable' } {
    const source = this.store.list().find((one) => one.id === id)
    if (source === undefined) return null
    /**
     * A fork is cut at the last **completed** turn, as DSH's is: a session with none has nothing to fork from, and a child
     * carrying a half-finished turn would invite the model to continue work it never saw finish.
     *
     * The question is "does the inherited projection contain an assistant message", not "does the log contain assistant
     * chunks": a fork's own log holds copied **messages**, never chunks, and keying the refusal on chunks made a fork of a
     * fork a `409` — measured on 2026-10-17. The same test still refuses a recorded question whose answer never arrived,
     * which is the case the old guard was added for.
     */
    const sourceHandle = this.store.open(id)
    if (sourceHandle === null) return { error: 'unavailable' }
    if (!inheritsAnswer(this.store.read(sourceHandle))) return { error: 'unavailable' }
    /** The child records its parent, which is the provenance DSH's header keeps (`parentSession`). */
    const handle = this.store.fork(id, { parentSession: id })
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
      ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
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
   *
   * That name is the **fallback**. When a model is attached (the session plugin attaches the model service), the
   * store's title coordinator then asks the session's own endpoint for a title once the turn's request is on record,
   * and the answer replaces the fallback unless a person renamed the session first (`./title.ts`).
   */
  user(handle: SessionHandle, text: string, source?: unknown): void {
    this.userContent(handle, [{ type: 'text', text }], source)
  }

  /**
   * Record a user turn whose content is more than text — an attached image or file keeps its typed block.
   *
   * The title is still taken from the **text** part: an attachment is not a name for the conversation, and a
   * message that carries only an attachment names nothing (the list keeps the folder's name until a person
   * types one). DSH titles from the first message the same way.
   */
  userContent(handle: SessionHandle, content: readonly ContentPart[], source?: unknown): void {
    if (content.length === 0) return
    this.store.message(handle, { role: 'user', content: [...content], ...(source !== undefined ? { source } : {}) })
    const meta = this.store.list().find((one) => one.id === handle.id)
    if (meta !== undefined && (meta.title === undefined || meta.title.trim().length === 0)) {
      const title = titleFrom(textOf(content))
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
    options: { readonly fresh?: boolean; readonly endpoint?: string; readonly model?: string; readonly reasoningEffort?: string; readonly title?: string } = {},
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
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
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

  /**
   * Retitle a session; the log is untouched and the meta record is the only thing rewritten.
   *
   * A rename is a person naming the session, so it **pins** the name: an automatic title still being generated for it
   * lands nowhere (DSH's `rename()` supersedes in-flight generation, dsh-session-title lib/index.js:295-311). Confirming
   * the automatic title unchanged counts as naming it, as it does there.
   */
  rename(id: SessionId, title: string): SessionMeta | null {
    this.store.titles.supersede(id)
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
  setModel(
    id: SessionId,
    selection: { readonly endpoint: string; readonly model?: string; readonly reasoningEffort?: string },
  ): SessionMeta | null {
    return this.store.setModel(id, selection)
  }

  /** The last complete answer, which is what a transcript read returns. */
  lastAnswer(handle: SessionHandle): string {
    return this.store.lastAnswer(handle)
  }

  /**
   * The access mode this session recorded, or `undefined` when it never chose one.
   *
   * Exposed on the service rather than left to each caller's own event walk: the fold is one rule (the last
   * `permission/mode` event wins, and a word outside the vocabulary throws), and two implementations of it
   * would be two answers to the question the gate asks on every call.
   */
  recordedMode(handle: SessionHandle): SandboxMode | undefined {
    return foldRecordedMode(this.store.read(handle))
  }

  /** The mode a call in this session runs under: its own record, else the deployment mode the caller names. */
  effectiveMode(handle: SessionHandle, fallback: SandboxMode): SandboxMode {
    return foldEffectiveMode(this.store.read(handle), fallback)
  }

  /**
   * Record a change of this session's access mode, and answer with what changed.
   *
   * One event, written **before** the change takes effect, which is the store's rule for everything that
   * matters: an interrupted switch is then either not recorded (and the old mode still applies) or recorded
   * (and the new one does), never half of each. Choosing the mode already in effect appends nothing, so a
   * no-op is not a log entry and the transcript keeps only real decisions.
   *
   * The validation here is a second line rather than the first: the HTTP route decides with
   * `permissionTransition` (which also owns the escalation confirmation), and this method refuses a word
   * that is not a mode at all so no caller can put one in the log.
   */
  setMode(
    handle: SessionHandle,
    mode: SandboxMode,
    fallback: SandboxMode,
  ): { readonly mode: SandboxMode; readonly changed: boolean; readonly event?: SessionEvent } {
    if (!isSandboxMode(mode)) throw new Error(`'${String(mode)}' is not a sandbox mode`)
    if (this.effectiveMode(handle, fallback) === mode) return { mode, changed: false }
    const event = this.store.append(handle, { type: MODE_EVENT, mode })
    return { mode, changed: true, event }
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
