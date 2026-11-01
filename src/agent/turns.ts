import { Service, type Context } from '@deepseek-ai/cordis'

/**
 * The live-turn registry: which sessions have a turn in flight **right now**, and how to stop one.
 *
 * This is the process-local half of what DSH reads from `agent.status`: durable logs cannot say "running",
 * because a running turn is a fact about this process. The team layer needs it for two answers — `list_agents`
 * (running vs inactive) and `interrupt_agent` (stop the target's turn) — and the loop is the only place that
 * knows a turn began and ended.
 *
 * A turn started through {@link TurnRegistry.enqueue} waits for every turn already in flight or queued on its
 * session, so one session runs one turn at a time: DSH's rule, under which a prompt sent to a busy session is a
 * follow-up claimed after the running turn, never a second concurrent turn (#28). The registry still keeps a **set**
 * per session, because {@link TurnRegistry.begin} registers without waiting: one interruption stops every turn of
 * the subject, and the session is running while at least one remains.
 */

export interface LiveTurn {
  /** Aborted when the session is interrupted. */
  readonly signal: AbortSignal
  /** Mark this turn finished; safe to call twice. */
  settle(): void
}

export class TurnRegistry extends Service {
  static readonly provide = 'turns'

  private readonly controllers = new Map<string, Set<AbortController>>()
  /** Who is waiting for a session to have no turn in flight; resolved by the settle that empties its set. */
  private readonly idleWaiters = new Map<string, (() => void)[]>()
  /** Per session, the promise that settles when the last turn queued on it has settled. */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'turns')
  }

  /**
   * Register a turn and return its signal.
   *
   * The signal is intended to be **combined** with the caller's own (`AbortSignal.any`), so an interrupt and a
   * person's stop are both honoured without either replacing the other.
   */
  begin(sessionId: string): LiveTurn {
    const controller = new AbortController()
    const existing = this.controllers.get(sessionId)
    if (existing === undefined) this.controllers.set(sessionId, new Set([controller]))
    else existing.add(controller)
    let settled = false
    return {
      signal: controller.signal,
      settle: () => {
        if (settled) return
        settled = true
        this.controllers.get(sessionId)?.delete(controller)
        if (this.controllers.get(sessionId)?.size === 0) {
          this.controllers.delete(sessionId)
          const waiters = this.idleWaiters.get(sessionId) ?? []
          this.idleWaiters.delete(sessionId)
          for (const wake of waiters) wake()
        }
      },
    }
  }

  /**
   * Register a turn once every turn already in flight or queued on the session has settled, in arrival order (#28).
   *
   * Measured before: two `POST /api/turn` for one session 300 ms apart both ran, interleaved their writes in one
   * log, and the first turn's next request carried the second's exchange, which the provider refused. DSH admits a
   * prompt sent to a busy session as a follow-up (`agent.followup`) and claims it after the running turn.
   *
   * On an idle session with nobody queued the turn is registered **at once** (`{ live }`), so a caller that relies on
   * its prompt being written before its first await keeps that. Otherwise it waits (`{ wait }`): first for the turns
   * queued before it, then for any turn registered without queueing.
   */
  enqueue(sessionId: string): { readonly live: LiveTurn } | { readonly wait: Promise<LiveTurn> } {
    const previous = this.queues.get(sessionId)
    if (previous === undefined && !this.isRunning(sessionId)) return { live: this.begin(sessionId) }
    let release!: () => void
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = (previous ?? Promise.resolve()).then(() => done)
    this.queues.set(sessionId, tail)
    const wait = (async (): Promise<LiveTurn> => {
      await previous
      await this.whenIdle(sessionId)
      const live = this.begin(sessionId)
      return {
        signal: live.signal,
        settle: () => {
          live.settle()
          release()
          if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId)
        },
      }
    })()
    return { wait }
  }

  isRunning(sessionId: string): boolean {
    return (this.controllers.get(sessionId)?.size ?? 0) > 0
  }

  /**
   * Resolve once the session has no turn in flight: at once when it has none now, otherwise at the settle that
   * empties its set.
   *
   * A background child's settlement notice needs it. A notice delivered into a running turn is answered by that
   * turn only if the turn notices it before ending, and the loop's last look for new input comes before its own
   * end; the deliverer waits here and then checks whether the notice was answered.
   */
  whenIdle(sessionId: string): Promise<void> {
    if (!this.isRunning(sessionId)) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(sessionId)
      if (waiters === undefined) this.idleWaiters.set(sessionId, [resolve])
      else waiters.push(resolve)
    })
  }

  running(): readonly string[] {
    return [...this.controllers.keys()]
  }

  /** Stop every turn in flight for one session; whether there was one to stop. */
  abort(sessionId: string, reason?: string): boolean {
    const controllers = this.controllers.get(sessionId)
    if (controllers === undefined || controllers.size === 0) return false
    for (const controller of [...controllers]) controller.abort(reason ?? 'interrupted')
    return true
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    turns: TurnRegistry
  }
}
