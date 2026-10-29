import { randomUUID } from 'node:crypto'

import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import type { SessionEvent, SessionHandle, SessionStore } from '../session/store.ts'

/**
 * Goal management, modelled on DSH's `dsh-goal` — read as
 * [`_context_/dsh-mechanisms/dsh-goal.md`](../../_context_/dsh-mechanisms/dsh-goal.md).
 *
 * The one idea, and everything else follows from it: **a goal is not a record that is updated; it is an
 * event that is appended.** Every mutation writes one `goal/change` event carrying the *complete*
 * snapshot (or a clear tombstone), and the current state is the fold of the log. That choice buys three
 * things heddle already relies on elsewhere: the history of a goal is auditable, replaying a session
 * reconstructs its goal, and a stale writer cannot silently overwrite a newer revision — the snapshot
 * carries its `revision`, and every mutation is a compare-and-set against it.
 *
 * Two lifetimes are kept deliberately apart, as in DSH:
 *
 * - `phase` is **durable** (`active | paused | blocked | complete`);
 * - `activation` is **process-local** (`armed | disarmed`) — "may this live process keep continuing the
 *   goal on its own". It is never written to the log, so a session reopened in a new process comes back
 *   with its durable phase intact and **disarmed**: only a person resuming it re-arms continuation.
 *   That is what stops a restarted process from spending rounds on its own.
 */

/** Version of the `goal/change` payload shape. A log written by a later version fails loudly. */
export const GOAL_CHANGE_VERSION = 1

/** Stable identity of one goal across its revisions. */
export type GoalId = string

/** Compare-and-set identity for one exact goal revision. */
export interface GoalRef {
  readonly id: GoalId
  /** Positive; every durable mutation increments it by one. */
  readonly revision: number
}

/** Durable lifecycle phase. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Whether this live process may keep continuing an active goal automatically. */
export type GoalActivation = 'armed' | 'disarmed'

/** Machine-routable and human-readable reason a goal is blocked. */
export interface GoalBlockReason {
  /** Stable lower-kebab-case classification. */
  readonly code: string
  /** Non-empty explanation a person and a model can read. */
  readonly message: string
}

/** Full durable state written by every non-clear mutation. */
export interface GoalSnapshot extends GoalRef {
  readonly objective: string
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}

/** The projection a reader (CLI, UI, tool) sees: durable snapshot plus what the log and the process add. */
export interface GoalView extends GoalSnapshot {
  /** Admitted continuation rounds for this goal — derived, not a stored counter. */
  readonly roundsStarted: number
  readonly createdAt: string
  readonly updatedAt: string
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
}

/** Stable refusals. A caller switches on the code, not on the sentence. */
export type GoalErrorCode =
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'
  | 'GOAL_INVALID_LOG'

/** A refused goal operation, with the stable code a caller can branch on. */
export class GoalError extends Error {
  readonly code: GoalErrorCode

  constructor(message: string, code: GoalErrorCode) {
    super(message)
    this.name = 'GoalError'
    this.code = code
  }
}

/** The durable projection of a session's goal, folded from its log. */
export interface FoldedGoal {
  /** The current goal, absent before the first create and after a clear. */
  readonly goal?: GoalSnapshot
  /** Admitted continuation rounds of the current goal. */
  readonly roundsStarted: number
  readonly createdAt?: string
  readonly updatedAt?: string
  /** The latest mutation identity, including a clear tombstone. */
  readonly lastRef?: GoalRef
}

/** Configuration of the goal service. */
export interface Config {
  /**
   * Round cap used when `create` does not name one.
   *
   * **100**, and a round is one automatic continuation of a goal. It was 256 — DSH's own default, copied when this
   * subsystem mirrored theirs — and the owner lowered it on 2026-10-17: a goal that has not converged after a hundred
   * rounds is not going to be converged by the hundred-and-first, and the cap is what makes the driver **block**
   * loudly instead of spending a night on one objective. A caller that knows better still names its own number, and
   * a person can raise it with `update_goal`.
   */
  readonly defaultMaxGoalRounds?: number
}

export const Config: Schema<Config> = Schema.object({
  defaultMaxGoalRounds: Schema.number().default(100),
})

/** The operations a snapshot change may record. `clear` has its own tombstone shape. */
const OPERATIONS = new Set(['create', 'edit', 'pause', 'resume', 'complete', 'block'])
const PHASES = new Set(['active', 'paused', 'blocked', 'complete'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string, code: GoalErrorCode = 'GOAL_INVALID_LOG'): never {
  throw new GoalError(message, code)
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer`)
  return value
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${name} must be a non-empty string`)
  return value
}

function validObjective(value: unknown): string {
  const objective = nonEmptyString(value, 'objective').trim()
  if (objective.length > 8000) throw new GoalError('an objective must be at most 8000 characters', 'GOAL_INVALID_OBJECTIVE')
  return objective
}

function validMaxGoalRounds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS')
  }
  return value
}

function validBlockReason(value: unknown): GoalBlockReason {
  if (!isRecord(value)) throw new GoalError('a blocked goal needs { code, message }', 'GOAL_INVALID_BLOCK_REASON')
  const code = typeof value.code === 'string' ? value.code.trim() : ''
  const message = typeof value.message === 'string' ? value.message.trim() : ''
  if (!/^[a-z][a-z0-9-]*$/.test(code)) {
    throw new GoalError('a block reason code must be lower-kebab-case, for example "missing-input"', 'GOAL_INVALID_BLOCK_REASON')
  }
  if (message.length === 0 || message.length > 2000) {
    throw new GoalError('a block reason message must be 1 to 2000 characters', 'GOAL_INVALID_BLOCK_REASON')
  }
  return { code, message }
}

function validRef(value: unknown): GoalRef {
  if (!isRecord(value)) fail('a goal reference needs { id, revision }')
  const id = nonEmptyString(value.id, 'goal id')
  return { id, revision: positiveInteger(value.revision, 'goal revision') }
}

/** One decoded `goal/change`: either a full snapshot change or a clear tombstone. */
type GoalChange =
  | {
      readonly operation: string
      readonly goal: GoalSnapshot
      readonly roundsStarted: number
      readonly createdAt: string
      readonly updatedAt: string
    }
  | { readonly operation: 'clear'; readonly cleared: GoalRef; readonly clearedAt: string }

/** Decode and validate one `goal/change` event; malformed events fail loudly rather than being skipped. */
export function decodeGoalChange(event: SessionEvent): GoalChange | undefined {
  if (event.type !== 'goal/change') return undefined
  if (event.version !== GOAL_CHANGE_VERSION) fail(`unsupported goal change version ${String(event.version)}`)
  const operation = typeof event.operation === 'string' ? event.operation : ''
  if (operation === 'clear') {
    const cleared = validRef(event.cleared)
    const clearedAt = String(event.clearedAt ?? '')
    if (clearedAt.length === 0) fail('a clear tombstone needs clearedAt')
    return { operation: 'clear', cleared, clearedAt }
  }
  if (!OPERATIONS.has(operation)) fail(`unknown goal operation ${JSON.stringify(operation)}`)
  const goal = event.goal
  if (!isRecord(goal)) fail('a goal change needs a snapshot')
  const id = nonEmptyString(goal.id, 'goal id')
  const revision = positiveInteger(goal.revision, 'goal revision')
  const objective = nonEmptyString(goal.objective, 'goal objective')
  const phase = typeof goal.phase === 'string' && PHASES.has(goal.phase) ? (goal.phase as GoalPhase) : fail(`unknown goal phase ${JSON.stringify(goal.phase)}`)
  const maxGoalRounds = validMaxGoalRounds(goal.maxGoalRounds)
  const blockedReason = goal.blockedReason === undefined ? undefined : { ...validBlockReason(goal.blockedReason) }
  if ((phase === 'blocked') !== (blockedReason !== undefined)) fail('a blockedReason exists exactly while the phase is blocked')
  return {
    operation,
    goal: { id, revision, objective, phase, maxGoalRounds, ...(blockedReason !== undefined ? { blockedReason } : {}) },
    roundsStarted: positiveIntegerOrZero(event.roundsStarted, 'roundsStarted'),
    createdAt: nonEmptyString(event.createdAt, 'createdAt'),
    updatedAt: nonEmptyString(event.updatedAt, 'updatedAt'),
  }
}

function positiveIntegerOrZero(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer`)
  return value
}

/** The goal round a goal-attributed user message announces, or undefined for any other event. */
function goalRoundOf(event: SessionEvent): { readonly goalId: string; readonly revision: number; readonly round: number } | undefined {
  if (event.type !== 'message') return undefined
  const message = event.message as { role?: string; source?: { kind?: string; goalId?: string; revision?: number; round?: number } } | undefined
  const source = message?.source
  if (message?.role !== 'user' || source?.kind !== 'goal') return undefined
  if (typeof source.goalId !== 'string' || typeof source.revision !== 'number') return undefined
  if (typeof source.round !== 'number' || source.round < 1) return undefined
  return { goalId: source.goalId, revision: source.revision, round: source.round }
}

/**
 * Fold a session's events into its current goal.
 *
 * Strict by design: a malformed mutation, a revision that does not advance by one, a reused goal id, a
 * non-`edit` operation that changes the definition, or a recorded `roundsStarted` that goes backwards fails
 * replay rather than producing a plausible-looking wrong state.
 *
 * **Rounds are counted in log order, across revisions**, as DSH's `dsh-goal` fold does: a goal change carries the
 * count forward, and a goal-sourced user message for the goal's revision at that point in the log raises the count to
 * its round. So a cap is a cap for the goal, not for one revision. The earlier fold counted only the final revision's
 * messages after the loop and took the larger of that and the recorded count, so after an edit the recorded count was
 * a floor instead of a base and the goal ran past its cap (R-developer-two-31: five rounds under a cap of three).
 *
 * Two leniencies keep logs written before that fix replayable where DSH would refuse them: a round number that does
 * not exceed the count (the old driver repeated `3/3` after an edit) is not counted again, and a recorded count lower
 * than the in-order count does not lower it.
 */
export function foldGoal(events: readonly SessionEvent[]): FoldedGoal {
  let goal: GoalSnapshot | undefined
  let roundsStarted = 0
  /** The count the last mutation of the current goal recorded; recorded counts may not go backwards. */
  let recorded = 0
  let createdAt: string | undefined
  let updatedAt: string | undefined
  let lastRef: GoalRef | undefined
  const seen = new Set<GoalId>()

  for (const event of events) {
    const round = goalRoundOf(event)
    if (round !== undefined) {
      if (goal !== undefined && round.goalId === goal.id && round.revision === goal.revision && round.round > roundsStarted) {
        roundsStarted = round.round
      }
      continue
    }
    const change = decodeGoalChange(event)
    if (change === undefined) continue

    if ('cleared' in change) {
      if (goal === undefined) fail('a clear tombstone needs a current goal to clear')
      if (change.cleared.id !== goal.id) fail('a clear tombstone must name the goal it clears')
      if (change.cleared.revision !== goal.revision + 1) fail('a clear tombstone revision must be one past the cleared goal')
      goal = undefined
      roundsStarted = 0
      recorded = 0
      createdAt = undefined
      updatedAt = undefined
      lastRef = change.cleared
      continue
    }

    const next = change.goal
    if (change.operation === 'create') {
      if (goal !== undefined && goal.phase !== 'complete') fail('a goal cannot be created while another is not complete')
      if (seen.has(next.id)) fail(`goal id ${next.id} was already used in this session`)
      if (next.revision !== 1) fail('a created goal starts at revision 1')
      seen.add(next.id)
    } else {
      if (goal === undefined) fail(`cannot ${change.operation} a goal when none is current`)
      if (next.id !== goal.id) fail(`goal ${change.operation} changed the goal id`)
      if (next.revision !== goal.revision + 1) fail(`goal ${change.operation} must advance the revision by one`)
      /**
       * Only `edit` may change what the goal *is*. Every other operation restates the definition it
       * was given; letting one of them slip a new objective in would make the transition table a lie.
       */
      if (change.operation !== 'edit' && (next.objective !== goal.objective || next.maxGoalRounds !== goal.maxGoalRounds)) {
        fail(`goal ${change.operation} cannot change objective or maxGoalRounds`)
      }
      if (goal.phase === 'complete' && change.operation !== 'clear') fail('a complete goal is not mutated; clear it and create a new one')
    }
    const sameGoal = next.id === lastRef?.id
    if (change.roundsStarted < recorded && sameGoal) fail('roundsStarted cannot go backwards')
    goal = next
    roundsStarted = sameGoal ? Math.max(roundsStarted, change.roundsStarted) : change.roundsStarted
    recorded = change.roundsStarted
    createdAt = change.createdAt
    updatedAt = change.updatedAt
    lastRef = { id: next.id, revision: next.revision }
  }

  return {
    ...(goal !== undefined ? { goal } : {}),
    roundsStarted,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(lastRef !== undefined ? { lastRef } : {}),
  }
}

/** The goal service: append-only mutations, a strict fold, and process-local activation. */
export class GoalService extends Service {
  static readonly provide = 'goal'

  private readonly store: SessionStore
  private readonly defaultMaxGoalRounds: number
  /**
   * Activation is process-local on purpose; an absent entry means **disarmed**, which is what a session
   * reopened in a new process gets. Only `create` and a human `resume` arm it.
   */
  private readonly activation = new Map<string, GoalActivation>()

  constructor(ctx: Context, store: SessionStore, config: Config = {}) {
    super(ctx, 'goal')
    this.store = store
    this.defaultMaxGoalRounds = config.defaultMaxGoalRounds ?? 100
  }

  /** The current goal, or `undefined` when none is current. */
  get(handle: SessionHandle): GoalView | undefined {
    return this.view(handle, foldGoal(this.store.read(handle)))
  }

  /** Remove process-local continuation authority without changing phase or revision. */
  disarm(handle: SessionHandle): GoalView | undefined {
    const folded = foldGoal(this.store.read(handle))
    if (folded.goal === undefined) return undefined
    this.activation.set(handle.id, 'disarmed')
    return this.view(handle, folded)
  }

  /** Create and arm a goal. A completed goal may be replaced; anything else must be cleared or resumed. */
  create(handle: SessionHandle, request: { readonly objective: string; readonly maxGoalRounds?: number }): GoalView {
    const folded = foldGoal(this.store.read(handle))
    if (folded.goal !== undefined && folded.goal.phase !== 'complete') {
      throw new GoalError(`goal ${folded.goal.id} already exists with phase ${folded.goal.phase}; clear or resume it`, 'GOAL_ALREADY_EXISTS')
    }
    const objective = validObjective(request.objective)
    const maxGoalRounds = request.maxGoalRounds === undefined ? validMaxGoalRounds(this.defaultMaxGoalRounds) : validMaxGoalRounds(request.maxGoalRounds)
    const now = new Date().toISOString()
    const goal: GoalSnapshot = { id: `goal-${randomUUID()}`, revision: 1, objective, phase: 'active', maxGoalRounds }
    this.append(handle, { operation: 'create', goal, roundsStarted: 0, createdAt: now, updatedAt: now })
    this.activation.set(handle.id, 'armed')
    return this.view(handle, foldGoal(this.store.read(handle))) as GoalView
  }

  /** Edit the objective and/or the round cap without changing the phase. */
  edit(handle: SessionHandle, ref: GoalRef, request: { readonly objective?: string; readonly maxGoalRounds?: number }): GoalView {
    const folded = foldGoal(this.store.read(handle))
    const current = this.expectCurrent(folded, ref)
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('an edit needs an objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT')
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...(request.objective === undefined ? {} : { objective: validObjective(request.objective) }),
      ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: validMaxGoalRounds(request.maxGoalRounds) }),
    }
    this.commit(handle, folded, 'edit', goal)
    return this.view(handle, foldGoal(this.store.read(handle))) as GoalView
  }

  /** Pause an active goal and stop automatic continuation. */
  pause(handle: SessionHandle, ref: GoalRef): GoalView {
    return this.transition(handle, ref, 'pause', ['active'], 'paused')
  }

  /**
   * Resume a stopped goal and re-arm continuation.
   *
   * Refused when the round budget is exhausted: resuming would re-arm a driver that has nowhere to go,
   * and the goal's next honest state is `complete` or a new `maxGoalRounds`.
   */
  resume(handle: SessionHandle, ref: GoalRef): GoalView {
    const folded = foldGoal(this.store.read(handle))
    const current = this.expectCurrent(folded, ref)
    const resumable: GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) this.transitionError(current, 'resume', resumable)
    if (current.phase === 'active' && this.activationOf(handle, current) === 'armed') {
      throw new GoalError(`goal ${current.id} is already active and armed`, 'GOAL_INVALID_TRANSITION')
    }
    if (folded.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(`goal ${current.id} exhausted ${current.maxGoalRounds} rounds; raise maxGoalRounds or complete it`, 'GOAL_INVALID_TRANSITION')
    }
    this.commit(handle, folded, 'resume', { ...current, revision: current.revision + 1, phase: 'active' })
    this.activation.set(handle.id, 'armed')
    return this.view(handle, foldGoal(this.store.read(handle))) as GoalView
  }

  /** Mark a non-complete goal complete and stop automatic continuation. */
  complete(handle: SessionHandle, ref: GoalRef): GoalView {
    return this.transition(handle, ref, 'complete', ['active', 'paused', 'blocked'], 'complete')
  }

  /** Mark an **active** goal blocked, with the reason it is blocked. */
  block(handle: SessionHandle, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const folded = foldGoal(this.store.read(handle))
    const current = this.expectCurrent(folded, ref)
    if (current.phase !== 'active') this.transitionError(current, 'block', ['active'])
    this.commit(handle, folded, 'block', { ...current, revision: current.revision + 1, phase: 'blocked', blockedReason: validBlockReason(reason) })
    this.activation.set(handle.id, 'disarmed')
    return this.view(handle, foldGoal(this.store.read(handle))) as GoalView
  }

  /** Clear the current goal, keeping a durable tombstone and the history. */
  clear(handle: SessionHandle, ref: GoalRef): GoalRef {
    const folded = foldGoal(this.store.read(handle))
    const current = this.expectCurrent(folded, ref)
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    this.store.append(handle, {
      type: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: new Date().toISOString(),
    })
    this.activation.set(handle.id, 'disarmed')
    return { ...tombstone }
  }

  /** The single shared phase transition: allowed-from check, then commit. */
  private transition(handle: SessionHandle, ref: GoalRef, operation: string, allowed: readonly GoalPhase[], phase: GoalPhase): GoalView {
    const folded = foldGoal(this.store.read(handle))
    const current = this.expectCurrent(folded, ref)
    if (!allowed.includes(current.phase)) this.transitionError(current, operation, allowed)
    this.commit(handle, folded, operation, { ...current, revision: current.revision + 1, phase })
    this.activation.set(handle.id, operation === 'resume' ? 'armed' : 'disarmed')
    return this.view(handle, foldGoal(this.store.read(handle))) as GoalView
  }

  private append(handle: SessionHandle, change: { operation: string; goal: GoalSnapshot; roundsStarted: number; createdAt: string; updatedAt: string }): void {
    this.store.append(handle, { type: 'goal/change', version: GOAL_CHANGE_VERSION, ...change })
  }

  /** Commit one snapshot change, keeping the goal's own derived counters and times. */
  private commit(handle: SessionHandle, folded: FoldedGoal, operation: string, goal: GoalSnapshot): void {
    /**
     * A reason exists **exactly while** the phase is `blocked`, and the fold enforces that.
     *
     * Leaving `blocked` must therefore drop it, not carry it: a `complete` or `resume` built by spreading
     * the blocked snapshot would otherwise write a phase that disagrees with its own reason, and the next
     * read would refuse the log it had just written. Found by the round-driver check, which completes a
     * goal that reached its cap.
     */
    const snapshot: GoalSnapshot =
      goal.phase === 'blocked' ? goal : (({ blockedReason: _dropped, ...rest }) => rest)(goal)
    this.append(handle, {
      operation,
      goal: snapshot,
      roundsStarted: folded.roundsStarted,
      createdAt: folded.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  private expectCurrent(folded: FoldedGoal, ref: GoalRef): GoalSnapshot {
    const current = folded.goal
    if (current === undefined) throw new GoalError(`no goal ${ref.id} is current`, 'GOAL_NOT_FOUND')
    if (current.id !== ref.id) throw new GoalError(`goal ${ref.id} is not the current goal (${current.id})`, 'GOAL_NOT_FOUND')
    if (current.revision !== ref.revision) {
      throw new GoalError(`goal ${ref.id} is at revision ${current.revision}, not ${ref.revision}; read it again`, 'GOAL_STALE_REVISION')
    }
    return current
  }

  private transitionError(current: GoalSnapshot, operation: string, allowed: readonly GoalPhase[]): never {
    throw new GoalError(
      `cannot ${operation} goal ${current.id} from phase ${current.phase}; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  /**
   * The process-local activation, defaulting from the **durable** phase.
   *
   * The owner's rule: goal pushing survives a harness restart. So an `active` goal is armed again by
   * default when a new process folds it; only a non-runnable phase starts disarmed. The map still carries an
   * in-process override (`disarm`), which is what a lifecycle owner uses without touching durable state.
   * This is a deliberate divergence from DSH, which disarms a reopened goal to stop a restarted process
   * spending rounds unsupervised; the cost of that is exactly the behaviour the owner rejected.
   */
  private activationOf(handle: SessionHandle, goal: GoalSnapshot): GoalActivation {
    return this.activation.get(handle.id) ?? (goal.phase === 'active' ? 'armed' : 'disarmed')
  }

  private view(handle: SessionHandle, folded: FoldedGoal): GoalView | undefined {
    if (folded.goal === undefined) return undefined
    return {
      ...folded.goal,
      roundsStarted: folded.roundsStarted,
      createdAt: folded.createdAt ?? '',
      updatedAt: folded.updatedAt ?? '',
      activation: this.activationOf(handle, folded.goal),
    }
  }
}

/** The goal plugin: the service wired to the session store, loaded by the profile. */
export default class GoalPlugin extends GoalService {
  static readonly Config = Config

  static readonly inject = ['session']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, ctx.session.store, config)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['goal']`. */
    goal: GoalService
  }
}
