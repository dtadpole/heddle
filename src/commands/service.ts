import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'

import { heddleHome } from '../config/schema.ts'
import { isSandboxMode, type SandboxMode } from '../sandbox/service.ts'
import type { SessionHandle } from '../session/store.ts'
import {
  compactCommand,
  exportCommand,
  feedbackCommand,
  permissionCommand,
  type CompactionOutcome,
} from './builtins.ts'
import { goalCommand, type GoalHost } from './goal.ts'
import type { CommandRouteHost } from './http.ts'
import { CommandRegistry, type CommandLog } from './registry.ts'

export const name = 'commands'

/**
 * The `commands` service: the registry, the built-in commands wired to the services they drive, and the host the
 * command routes read.
 *
 * Only the session store is required. The goal, context, model and sandbox services are read **when a command
 * runs** (`ctx.get`), so a profile without one still lists every command and the command that needs the absent
 * service answers with a sentence naming it, rather than the whole layer failing to load.
 */
export class CommandService extends Service {
  readonly registry = new CommandRegistry()
  readonly log: CommandLog
  readonly routes: CommandRouteHost

  constructor(ctx: Context) {
    super(ctx, 'commands')
    const store = ctx.session.store
    this.log = { append: (handle, event) => store.append(handle, event) }
    this.routes = { registry: this.registry, log: this.log, open: (id) => store.open(id) }

    // `/goal` is developer-nine's (goal.ts). It gets no follow-up sink yet: nothing here can start the turn that
    // carries a goal objective's attachments (the TODO in goal.ts).
    this.registry.register(goalCommand(goalHost(ctx)))
    this.registry.register(
      compactCommand({ compactNow: (handle) => compactNow(ctx, handle) }),
    )
    this.registry.register(feedbackCommand(this.log, () => anonymousUser()))
    this.registry.register(
      permissionCommand({
        current: (handle) => ctx.session.effectiveMode(handle, sandboxDefault(ctx)),
        set: (handle, mode) => ctx.session.setMode(handle, mode, sandboxDefault(ctx)),
      }),
    )
    this.registry.register(exportCommand())
  }
}

/** The goal service, looked up per run, or a host whose every call names its absence. */
function goalHost(ctx: Context): GoalHost {
  const goals = (): GoalHost => {
    const service = ctx.get('goal') as GoalHost | undefined
    if (service === undefined) throw new Error('the goal service is not loaded in this profile')
    return service
  }
  return {
    get: (handle) => goals().get(handle),
    create: (handle, request) => goals().create(handle, request),
    edit: (handle, ref, request) => goals().edit(handle, ref, request),
    pause: (handle, ref) => goals().pause(handle, ref),
    resume: (handle, ref) => goals().resume(handle, ref),
    clear: (handle, ref) => goals().clear(handle, ref),
  }
}

/** The deployment's sandbox mode, the fallback a session without a recorded mode runs under. */
function sandboxDefault(ctx: Context): SandboxMode {
  const mode = (ctx.get('sandbox') as { mode?: unknown } | undefined)?.mode
  return isSandboxMode(mode) ? mode : 'workspace-write'
}

/** The context service's surface `/compact` uses. */
interface ContextLike {
  measure(handle: SessionHandle): { readonly totalTokens: number; readonly nodes: readonly unknown[] }
  prepare(
    handle: SessionHandle,
    options: { readonly cwd: string; readonly endpoint: string; readonly model?: string; readonly force?: boolean },
  ): Promise<{ readonly compacted: boolean }>
}

/**
 * Summarise the session's older history now: the context service's forced reduction, priced before and after.
 *
 * The endpoint that summarises is the one the session's turns use — its recorded endpoint, else the model service's
 * default — so a manual compaction is written in the same voice as an automatic one.
 */
async function compactNow(ctx: Context, handle: SessionHandle): Promise<CompactionOutcome> {
  /**
   * DSH compacts by hand only an idle session: an open turn or another compaction answers `busy`
   * (dsh-compaction-basic compactSurfaceRegion and compactNow). A compaction under a running turn would replace the
   * history that turn is still writing, its own prompt included (#133).
   */
  const turns = ctx.get('turns') as { isRunning(sessionId: string): boolean } | undefined
  if (turns?.isRunning(handle.id) === true || compacting.has(handle.id)) return { compacted: false, busy: true }
  compacting.add(handle.id)
  try {
    return await compactIdle(ctx, handle)
  } finally {
    compacting.delete(handle.id)
  }
}

/** Sessions with a manual compaction in flight in this process. */
const compacting = new Set<string>()

async function compactIdle(ctx: Context, handle: SessionHandle): Promise<CompactionOutcome> {
  const context = ctx.get('context') as ContextLike | undefined
  if (context === undefined) throw new Error('Compaction is unavailable because the context service is not loaded.')
  const meta = ctx.session.list().find((entry) => entry.id === handle.id)
  const models = ctx.get('model') as { defaultEndpoint?: () => string | undefined } | undefined
  const endpoint = meta?.endpoint ?? models?.defaultEndpoint?.()
  if (endpoint === undefined) throw new Error('Compaction is unavailable because no model endpoint is configured to summarise with.')
  const before = context.measure(handle)
  const lastSeq = ctx.session.store.read(handle).at(-1)?.seq ?? 0
  const report = await context.prepare(handle, {
    cwd: meta?.cwd ?? handle.dir,
    endpoint,
    ...(meta?.model !== undefined ? { model: meta.model } : {}),
    force: true,
  })
  if (!report.compacted) {
    /** A summary the engine refused is recorded as `compaction/failed {refused: true}`; DSH reports it as an error (#132). */
    const refusal = ctx.session.store
      .read(handle)
      .find((event) => event.seq > lastSeq && event.type === 'compaction/failed' && (event as { refused?: unknown }).refused === true)
    if (refusal !== undefined) return { compacted: false, refused: String((refusal as { reason?: unknown }).reason ?? 'refused') }
    return { compacted: false }
  }
  const after = context.measure(handle)
  const events = ctx.session.store.read(handle)
  const summary = [...events].reverse().find((event) => event.type === 'compaction/summary')
  return {
    compacted: true,
    items: Math.max(1, before.nodes.length - after.nodes.length + 1),
    tokens: Math.max(0, before.totalTokens - after.totalTokens),
    ...(summary !== undefined ? { summarySeq: summary.seq } : {}),
  }
}

/**
 * The anonymous id `/feedback` signs with: one random UUID per heddle home, created on first use.
 *
 * DSH prints an anonymous user id with every recorded feedback so two notes from one person can be told apart without
 * knowing who they are; a file under the heddle home is the same promise without an account.
 */
function anonymousUser(): string {
  const home = heddleHome()
  const path = join(home, 'feedback-user-id')
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(stored)) return stored
  }
  const id = randomUUID()
  mkdirSync(home, { recursive: true })
  writeFileSync(path, `${id}\n`, { mode: 0o600 })
  return id
}

/** The commands plugin, loaded by the profile. */
export default class CommandPlugin extends CommandService {
  static readonly inject = ['session']
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['commands']`. */
    commands: CommandService
  }
}
