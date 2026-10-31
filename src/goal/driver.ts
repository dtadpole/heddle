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

/**
 * How a turn ended, as far as the driver acts on it: the `turn/end` reasons DSH's driver listens for.
 *
 * - `stopped`: the caller cancelled it (DSH's `aborted`);
 * - `failed`: it threw (DSH's `agent/error`);
 * - `max-tokens`: its last answer was cut at the output limit;
 * - `completed`: anything else.
 */
export type TurnEnd = 'completed' | 'stopped' | 'failed' | 'max-tokens'

/** The fields of a turn's last `assistant/completed` and its `turn/completed` that say how it ended. */
export interface TurnEndEvidence {
  readonly finishReason?: unknown
  readonly ended?: unknown
  readonly stopped?: unknown
  readonly error?: unknown
}

/**
 * Read how a turn ended from its closing records.
 *
 * A turn that threw writes `turn/completed` with `stopped: true` or an `error`. A turn stopped between steps returns
 * normally, and only its `assistant/completed` says so: `ended` carries "stopped by the caller", or the finish reason
 * is `aborted`. A cut at the output limit is the canonical `max_output_tokens`.
 */
export function turnEndOf(completed: TurnEndEvidence | undefined, closing: TurnEndEvidence): TurnEnd {
  const ended = Array.isArray(completed?.ended) ? (completed.ended as unknown[]) : []
  if (closing.stopped === true || completed?.finishReason === 'aborted' || ended.includes('stopped by the caller')) return 'stopped'
  if (closing.error !== undefined || completed?.finishReason === 'error') return 'failed'
  if (completed?.finishReason === 'max_output_tokens') return 'max-tokens'
  return 'completed'
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

/** One session's reconciliation lane: the in-flight chain and whether a re-evaluation is pending. */
interface Lane {
  /** An edge arrived while the chain was running, so the condition must be evaluated once more. */
  requested: boolean
  /** The chain currently draining, if any. */
  run?: Promise<DriverOutcome>
  /** One of this driver's rounds is running in the session now. */
  roundRunning: boolean
  /** The running round was stopped by the caller: the goal is paused once the round returns. */
  cancelled: boolean
}

/** The driver service: one serialized chain per session, started from the session's own turn events. */
export class GoalDriver extends Service {
  static readonly provide = 'goalDriver'

  private readonly goals: GoalService
  private readonly deps: GoalDriverDeps
  /**
   * One reconciliation lane per session.
   *
   * The driver is a **reconciler**, not a subscriber: an edge (a turn completed, the goal changed) never
   * carries meaning of its own, it only says "the state may have changed, look again". Edges are collapsed
   * into a `requested` flag on the lane, and a lane that is already draining keeps the flag set — so an
   * edge that arrives **while a chain is running is not lost**: when the current pass ends, the lane
   * re-evaluates the same condition once more before it settles.
   */
  private readonly lanes = new Map<string, Lane>()

  constructor(ctx: Context, goals: GoalService, deps: GoalDriverDeps) {
    super(ctx, 'goalDriver')
    this.goals = goals
    this.deps = deps
  }

  /**
   * Ask the driver to re-evaluate one session.
   *
   * Idempotent and reentrant: calling it from any edge, any number of times, is safe. A call while a chain
   * is running joins that chain **and** requests one more pass after it; a call after it has settled starts
   * a new chain. This is what makes the trigger robust to a dropped or duplicated event — the condition,
   * not the event, decides.
   */
  request(handle: SessionHandle): Promise<DriverOutcome> {
    const lane = this.laneFor(handle.id)
    lane.requested = true
    if (lane.run === undefined) {
      /**
       * Start the drain **after** the promise is stored on the lane.
       *
       * `drain` runs synchronously up to its first await, and the first thing it does is run a round — which
       * can itself call `request` (the round's own edges). Storing the promise first means that nested call
       * sees the lane as busy and only sets `requested`, instead of starting an overlapping second drain.
       * Measured by a unit test whose round completed the goal: without this the nested call started its own
       * drain and the awaited one settled with the stale outcome.
       */
      lane.run = Promise.resolve().then(() => this.drain(handle, lane))
    }
    return lane.run
  }

  /**
   * Tell the driver how one of the session's turns ended (DSH's `turn/end` and `agent/error` listeners,
   * `dsh-goal-round-driver/lib/index.js:211-213, 265-284`).
   *
   * - A turn stopped while one of this driver's rounds runs is that round, cancelled: the goal is **paused** once the
   *   round returns ("a goal whose round was under way is paused at the next idle point").
   * - A turn stopped while no round runs only **disarms** continuation ("a cancellation unrelated to a goal attempt
   *   only disarms continuation").
   * - A failed turn, or one cut at the output limit, disarms continuation: "No abnormal auto-retry", and the driver
   *   "stops on its own when a turn ends on max tokens". A person's resume re-arms it.
   *
   * Called synchronously from the turn's own `turn/completed`, which the loop writes before the round's `run`
   * returns, so the chain sees the outcome before it would decide on another round.
   */
  turnEnded(handle: SessionHandle, end: TurnEnd): void {
    if (end === 'completed') return
    const lane = this.laneFor(handle.id)
    if (end === 'stopped' && lane.roundRunning) {
      lane.cancelled = true
      return
    }
    this.goals.disarm(handle)
  }

  /** Await a chain. The CLI's join after a one-shot turn; identical to `request`. */
  advance(handle: SessionHandle): Promise<DriverOutcome> {
    return this.request(handle)
  }

  private laneFor(id: string): Lane {
    const existing = this.lanes.get(id)
    if (existing !== undefined) return existing
    const lane: Lane = { requested: false, roundRunning: false, cancelled: false }
    this.lanes.set(id, lane)
    return lane
  }

  /**
   * Drain a lane: one pass per requested evaluation, re-evaluated after every pass.
   *
   * A pass runs rounds until the condition says stop, so the usual chain is one pass. The loop exists for
   * the other case: an edge that arrived while the pass was running. The pass may have decided to stop
   * *before* that edge landed, and without this loop the edge would be silently dropped — which is exactly
   * the fragility of an event-only trigger.
   */
  private async drain(handle: SessionHandle, lane: Lane): Promise<DriverOutcome> {
    let rounds = 0
    let stopped = 'idle'
    let blocked: GoalBlockReason | undefined
    let error: string | undefined
    try {
      while (lane.requested) {
        lane.requested = false
        const outcome = await this.reconcile(handle, lane)
        rounds += outcome.rounds
        stopped = outcome.stopped
        if (outcome.blocked !== undefined) blocked = outcome.blocked
        if (outcome.error !== undefined) error = outcome.error
      }
    } finally {
      lane.run = undefined
    }
    return {
      rounds,
      stopped,
      ...(blocked !== undefined ? { blocked } : {}),
      ...(error !== undefined ? { error } : {}),
    }
  }

  /**
   * Start the goals this process finds already runnable.
   *
   * The reason the driver is a **level-triggered reconciler** rather than an event subscriber: after a
   * harness restart no edge ever fires for a session that was being pushed, so a purely edge-driven driver
   * would leave an active goal idle until a person happened to send a message. This sweep is the missing
   * edge — it reads durable state and asks the same condition, which is why it needs no new persisted field:
   * an **active** goal is armed again in a new process, on purpose (the owner's rule: pushing survives a
   * restart).
   */
  async resumeAtStart(handles: readonly SessionHandle[]): Promise<{ readonly requested: number }> {
    let requested = 0
    for (const handle of handles) {
      const view = this.goals.get(handle)
      if (view === undefined) continue
      const decision = decideGoalRound(view)
      if (decision.kind !== 'round') continue
      requested += 1
      void this.request(handle).catch(() => {
        // A failed chain is reported by its own outcome; boot must not be kept waiting on it.
      })
    }
    return { requested }
  }

  /** One evaluation of the condition: act on it until it stops being runnable. */
  private async reconcile(handle: SessionHandle, lane: Lane): Promise<DriverOutcome> {
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
      let failure: unknown
      let failed = false
      lane.roundRunning = true
      lane.cancelled = false
      try {
        await this.deps.run(handle, decision.prompt, {
          kind: 'goal',
          goalId: view!.id,
          revision: view!.revision,
          round: decision.round,
        })
      } catch (error) {
        failed = true
        failure = error
      } finally {
        lane.roundRunning = false
      }
      /**
       * The round was stopped (#93): DSH pauses the goal whose round was under way, so nothing continues on its own
       * and a person's resume is what starts the next round. Only the goal the round belonged to is paused.
       */
      if (lane.cancelled) {
        lane.cancelled = false
        const current = this.goals.get(handle)
        if (current !== undefined && current.id === view!.id && current.phase === 'active') {
          try {
            this.goals.pause(handle, { id: current.id, revision: current.revision })
          } catch (error) {
            this.goals.disarm(handle)
            return { rounds: rounds + 1, stopped: 'cancelled', error: messageOf(error) }
          }
        }
        return { rounds: rounds + 1, stopped: 'cancelled' }
      }
      if (failed) {
        /**
         * A turn that failed is not a queue failure: the goal keeps its phase, the error is reported rather than
         * swallowed, and continuation was disarmed by the turn's own end (`turnEnded`), so nothing retries it on
         * its own (DSH: "No abnormal auto-retry").
         */
        return { rounds, stopped: 'turn-failed', error: messageOf(failure) }
      }

      /**
       * Yield to the event loop between rounds.
       *
       * A round is an await, but a fast model resolves every await as a microtask, and a chain of microtasks
       * never gives the HTTP server a turn: measured with a scripted endpoint and a 500-round goal, the
       * process stayed alive and stopped answering requests (the page's fetch failed while the loop ran).
       * The yield is also what lets a person's pause land between rounds instead of after the whole chain.
       */
      await new Promise<void>((resolve) => setImmediate(resolve))

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
