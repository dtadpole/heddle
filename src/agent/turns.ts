import { Service, type Context } from '@deepseek-ai/cordis'

/**
 * The live-turn registry: which sessions have a turn in flight **right now**, and how to stop one.
 *
 * This is the process-local half of what DSH reads from `agent.status`: durable logs cannot say "running",
 * because a running turn is a fact about this process. The team layer needs it for two answers — `list_agents`
 * (running vs inactive) and `interrupt_agent` (stop the target's turn) — and the loop is the only place that
 * knows a turn began and ended.
 *
 * A session may have more than one turn in flight (the Web server allows it, deliberately, and says so where it
 * counts them), so the registry keeps a **set** per session: one interruption stops every turn of the subject,
 * and the session is running while at least one remains.
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
