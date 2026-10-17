import { Context, Service } from '@deepseek-ai/cordis'

import type { SessionHandle } from '../session/store.ts'
import type { GoalBlockReason, GoalService, GoalView } from './service.ts'

/**
 * The goal round driver: what makes an active goal actually continue.
 *
 * Modelled on DSH's `dsh-goal-round-driver`, read as
 * [`_context_/dsh-mechanisms/dsh-goal.md`](../../_context_/dsh-mechanisms/dsh-goal.md). The contract,
 * in three sentences:
 *
 * 1. **A round is a user message the harness wrote**, carrying `source = { kind:'goal', goalId,
 *    revision, round }` — the same message the loop then answers. The goal fold counts *admitted*
 *    rounds from those messages, so the cap is enforced against the log rather than a counter.
 * 2. **One round at a time, serialized per session.** A second trigger while a round is running joins
 *    the first chain instead of starting a concurrent one; a round that does not advance the count
 *    stops the chain, because that is the shape of a loop that would never end.
 * 3. **The driver stops when the goal stops being runnable** — completed, blocked, paused, cleared, or
 *    **disarmed** (a session reopened in a new process is disarmed on purpose). Reaching the cap is not
 *    a stop: it is the goal's own honest end, so the driver **blocks** with `round-limit`.
 */

/** The block code used when the round cap is reached; DSH's own. */
export const ROUND_LIMIT_CODE = 'round-limit'

/** The block code used when a round cannot be started at all. */
export const QUEUE_FAILED_CODE = 'queue-failed'

/** What should happen next for one goal. */
export type RoundDecision =
  | { readonly kind: 'round'; readonly round: number; readonly prompt: string }
  | { readonly kind: 'block'; readonly reason: GoalBlockReason }
  | { readonly kind: 'stop'; readonly why: string }

/**
 * The prompt one continuation round carries — DSH's text, because a model that has been told what it is
 * doing keeps doing it.
 *
 * It restates the objective and the round number every time rather than relying on the conversation: the
 * goal is the durable thing, and a round is a fresh request whose instructions must stand on their own.
 */
export function renderGoalRoundPrompt(goal: Pick<GoalView, 'objective' | 'maxGoalRounds'>, round: number): string {
  return [
    `Objective: ${JSON.stringify(goal.objective)}`,
    `Round: ${round}/${goal.maxGoalRounds}`,
    '',
    'Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.',
  ].join('\n')
}

/**
 * Decide what the driver does for one goal read.
 *
 * A pure function so the decision can be judged without a session, a process or a timer — and the
 * decision is where the mistakes live: running a paused goal, running past the cap, or continuing a goal
 * this process is not allowed to continue.
 */
export function decideGoalRound(goal: GoalView | undefined): RoundDecision {
  if (goal === undefined) return { kind: 'stop', why: 'no-goal' }
  if (goal.phase !== 'active') return { kind: 'stop', why: `phase-${goal.phase}` }
  if (goal.activation !== 'armed') return { kind: 'stop', why: 'disarmed' }
  if (goal.roundsStarted >= goal.maxGoalRounds) {
    return {
      kind: 'block',
      reason: { code: ROUND_LIMIT_CODE, message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.` },
    }
  }
  const round = goal.roundsStarted + 1
  return { kind: 'round', round, prompt: renderGoalRoundPrompt(goal, round) }
}

/** How one round is run: append the attributed user message and answer it with a turn. */
export interface GoalDriverDeps {
  readonly run: (handle: SessionHandle, prompt: string, source: Record<string, unknown>) => Promise<unknown>
}

/** What one `advance` call did. */
export interface DriverOutcome {
  /** Rounds that were admitted and answered. */
  readonly rounds: number
  /** Why the chain ended: `idle`, `no-goal`, `disarmed`, `phase-complete`, `round-limit`, `goal-moved`, … */
  readonly stopped: string
  /** Present when the chain ended by blocking the goal. */
  readonly blocked?: GoalBlockReason
  /** Present when a round could not be run at all. */
  readonly error?: string
}

/** The driver service: one serialized chain per session, started from the session's own turn events. */
export class GoalDriver extends Service {
  static readonly provide = 'goalDriver'

  private readonly goals: GoalService
  private readonly deps: GoalDriverDeps
  /** The chain already running for a session, so a second trigger joins it rather than racing it. */
  private readonly running = new Map<string, Promise<DriverOutcome>>()

  constructor(ctx: Context, goals: GoalService, deps: GoalDriverDeps) {
    super(ctx, 'goalDriver')
    this.goals = goals
    this.deps = deps
  }

  /**
   * Continue the session's goal until it stops being runnable, returns, or is exhausted.
   *
   * Joining an in-flight chain is deliberate: the driver triggers off `turn/completed`, which fires for
   * *every* turn — including the ones this driver itself runs — so without joining, each round would start
   * another chain and the rounds would multiply.
   */
  advance(handle: SessionHandle): Promise<DriverOutcome> {
    const existing = this.running.get(handle.id)
    if (existing !== undefined) return existing
    const chain = this.drive(handle).finally(() => {
      this.running.delete(handle.id)
    })
    this.running.set(handle.id, chain)
    return chain
  }

  private async drive(handle: SessionHandle): Promise<DriverOutcome> {
    let rounds = 0
    for (;;) {
      const view = this.goals.get(handle)
      const decision = decideGoalRound(view)
      if (decision.kind === 'stop') return { rounds, stopped: decision.why }
      if (decision.kind === 'block') {
        /**
         * Reaching the cap is the goal's honest end, not a driver failure: it is recorded as a block with
         * DSH's `round-limit` code so a reader — and the tool — can see why the rounds stopped.
         */
        try {
          this.goals.block(handle, { id: view!.id, revision: view!.revision }, decision.reason)
        } catch (error) {
          return { rounds, stopped: 'round-limit', blocked: decision.reason, error: messageOf(error) }
        }
        return { rounds, stopped: 'round-limit', blocked: decision.reason }
      }

      const before = view!.roundsStarted
      try {
        await this.deps.run(handle, decision.prompt, {
          kind: 'goal',
          goalId: view!.id,
          revision: view!.revision,
          round: decision.round,
        })
      } catch (error) {
        /**
         * A turn that failed is not a queue failure: the goal is left as it is, so a later trigger can try
         * again, and the error is reported rather than swallowed.
         */
        return { rounds, stopped: 'turn-failed', error: messageOf(error) }
      }

      const after = this.goals.get(handle)
      if (after === undefined) return { rounds: rounds + 1, stopped: 'cleared' }
      /**
       * The safety that keeps a broken driver from spinning: a round counts only if the log shows an
       * admitted goal message for it. If the count did not move, the next decision would pick the same
       * round again — an infinite loop — so the chain stops and says so.
       */
      if (after.roundsStarted <= before) return { rounds: rounds + 1, stopped: 'round-not-admitted' }
      rounds += 1
      /**
       * If the goal moved while the round ran — edited, paused, completed by the model itself — the chain
       * stops. The round that just ran stays in the log attributed to the revision it was started under,
       * which is exactly what "this round belongs to that goal" means.
       */
      if (after.id !== view!.id || after.revision !== view!.revision) return { rounds, stopped: 'goal-moved' }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Provided by the driver plugin, and absent in profiles that leave it out — a read is a proxy lookup,
     * so a caller checks it rather than assuming a turn has a goal driver.
     */
    goalDriver: GoalDriver
  }
}
