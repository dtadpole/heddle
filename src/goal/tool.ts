import Schema from '@deepseek-ai/schemastery'

import type { SessionEvent, SessionHandle } from '../session/store.ts'
import type { ToolContext, ToolDefinition, ToolResult } from '../tools/service.ts'
import { GoalError, type GoalService, type GoalView } from './service.ts'

/**
 * The model-facing goal tools, modelled on DSH's `dsh-tool-goal` (0.2.1-rc.2, `lib/index.js`) — read with line
 * citations in the DSH-parity spec `goals-todo-spec.md`, section A (R-developer-nine-2, -3, -4).
 *
 * Three tools rather than one, and the split is the point:
 *
 * - `create_goal` — a long-running request becomes a persisted goal. DSH's own description says the
 *   intent may be **inferred** from the request in any language, and that single-turn work is not a goal.
 * - `get_goal` — read the current goal, including the `id` and `revision` every mutation needs.
 * - `update_goal` — `edit`, `pause`, `resume`, `complete` or `blocked`, each a compare-and-set against that ref.
 *
 * **Who may ask** is decided here, at execution, from the session's own log (DSH's `authority.js`):
 *
 * - `create_goal`, and `edit`, `pause` and `resume`, need a **direct human turn**: a top-level session (its
 *   metadata names no delegation depth, or depth 0) whose open turn holds a person's message. A person's message is
 *   written with no `source`; everything the harness writes carries one (a goal round, a reminder, team mail, a
 *   child's settlement notice), so a turn the harness started never borrows a person's authority.
 * - `complete` and `blocked` need a direct human turn **or the current goal round**: the driver's message in the
 *   open turn with `source = { kind:'goal', goalId, revision, round }` matching the goal's id, revision and
 *   `roundsStarted`. An edit mid-round bumps the revision, so that round loses the authority.
 * - A goal round may not mark the goal `blocked` before `blockedAfterConsecutiveRounds` rounds have started
 *   (default 3); a person may at once.
 * - A **paused** goal is the person's decision, so the model cannot resume it; it may re-arm an active but
 *   disarmed goal, or resume a blocked one, when a person asks.
 *
 * Only a goal round's terminal verb is told to end the run: the closing instruction is DSH's deferred
 * `<goal_complete>` / `<goal_blocked>` notice, appended to the tool's answer because heddle's tool context has
 * no deferred-context hook. A person's own `complete` or `blocked` ends nothing, as in DSH.
 */

/** The `update_goal` verbs, exactly DSH's (dsh-tool-goal:116-122). */
export const UPDATE_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked'] as const

/** One `update_goal` verb. */
export type UpdateAction = (typeof UPDATE_ACTIONS)[number]

/**
 * Verbs an older schema offered, accepted but never advertised.
 *
 * Heddle's first schema named the edit verb `update`. A session that ran under it holds `update_goal` calls with
 * `action: "update"`, and a model reading that history imitates it; refusing the old spelling would turn a working
 * habit into a failed call for no gain. It is not in the enum, so nothing new is taught to use it.
 */
const LEGACY_ACTIONS: ReadonlyMap<string, UpdateAction> = new Map([['update', 'edit']])

/** Configuration of the goal tools: DSH's `tool-goal` config. */
export interface GoalToolConfig {
  /**
   * Goal rounds that must have started before a goal round may mark its goal `blocked`.
   *
   * DSH's `blockedAfterConsecutiveRounds`, a positive safe integer defaulting to 3. Counted as the goal's
   * `roundsStarted`, which edit, pause, resume and block keep, so "consecutive" is DSH's name rather than a tracked
   * streak. It binds only goal-round authority: a person may mark a goal blocked at once.
   */
  readonly blockedAfterConsecutiveRounds?: number
}

export const GoalToolConfig: Schema<GoalToolConfig> = Schema.object({
  blockedAfterConsecutiveRounds: Schema.number().step(1).min(1).default(3),
})

/** The default block threshold, DSH's. */
export const DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3

/** Validate the config even when a caller skips the schema, as DSH's `resolveConfig` does. */
export function resolveGoalToolConfig(config: GoalToolConfig = {}): { readonly blockedAfterConsecutiveRounds: number } {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError('blockedAfterConsecutiveRounds must be a positive safe integer')
  }
  return { blockedAfterConsecutiveRounds: blockedAfter }
}

/**
 * DSH's `tool:goal` system-prompt section, with the deployment's block threshold.
 *
 * Exported for the layer that assembles the system prompt: heddle has no per-tool prompt section, so the tools
 * cannot install it themselves.
 */
export function goalToolGuidance(blockedAfter: number = DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS): string {
  return `create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least ${blockedAfter} consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.`
}

const CREATE_DESCRIPTION =
  'Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.'

const GET_DESCRIPTION = 'Read the current session goal, including the id and revision that update_goal requires.'

const UPDATE_DESCRIPTION = 'Update the current goal.'

const ACTION_DESCRIPTION =
  'edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.'

/** DSH's refusal sentences, verbatim (dsh-tool-goal:64, 79, 214, 344-360); the model reads them back. */
export const GOAL_TOOL_MESSAGES = {
  humanRequired: 'this goal operation requires a direct human turn on a top-level agent',
  completionAuthority: 'complete and blocked require a direct human turn or the current goal round',
  resumePaused: 'the model cannot resume a paused goal; the user must resume it',
  badRef: 'goal_id must be non-empty and revision must be a positive safe integer',
  reasonOnlyWithBlocked: 'blocked_reason is valid only with action blocked',
  fieldsOnlyWithEdit: 'objective and max_goal_rounds are valid only with action edit',
  pauseResumeFields: 'objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked',
  reasonRequired: 'blocked_reason is required with action blocked',
  blockThreshold: (blockedAfter: number, roundsStarted: number) =>
    `blocked requires at least ${blockedAfter} consecutive goal rounds; current round is ${roundsStarted}`,
} as const

/** A refusal decided by the tools rather than the goal domain, with its stable code. */
class GoalToolRefusal extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'GoalToolRefusal'
    this.code = code
  }
}

function reject(message: string, code = 'GOAL_TOOL_AUTHORITY_REQUIRED'): never {
  throw new GoalToolRefusal(message, code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The events of the turn that is open now: everything after the last turn end.
 *
 * Heddle writes no turn-start event; a turn ends with `turn/completed` (the loop) or `turn/failed` (a teammate's
 * failed turn), so the open turn is the suffix after the last of those. A tool runs inside a turn, so the suffix
 * holds the message that started it and any message steered into it since.
 */
export function openTurnEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'turn/completed' || type === 'turn/failed') return events.slice(index + 1)
  }
  return events
}

/** The `source` of a recorded user message, `{ present: false }` for a message with none, or undefined. */
function userMessageSource(event: SessionEvent): { readonly present: boolean; readonly source?: unknown } | undefined {
  if (event.type !== 'message') return undefined
  const message = event.message
  if (!isRecord(message) || message.role !== 'user') return undefined
  return 'source' in message && message.source !== undefined ? { present: true, source: message.source } : { present: false }
}

/** Whether a session runs at the top level: its record names no delegation depth, or depth 0. */
export function isTopLevel(meta: { readonly delegationDepth?: unknown } | undefined): boolean {
  const depth = meta?.delegationDepth
  return depth === undefined || depth === 0
}

/**
 * Whether the open turn holds a person's message on a top-level session — DSH's `hasDirectHumanInput`.
 *
 * A person's message carries no `source` (or DSH's explicit `{ kind:'user' }`); any other source — a goal round,
 * a reminder, team mail, a child's notice, a `null` — is the harness speaking, and grants nothing.
 */
export function hasDirectHumanInput(turn: readonly SessionEvent[], meta: { readonly delegationDepth?: unknown } | undefined): boolean {
  if (!isTopLevel(meta)) return false
  return turn.some((event) => {
    const found = userMessageSource(event)
    if (found === undefined) return false
    if (!found.present) return true
    return isRecord(found.source) && found.source.kind === 'user'
  })
}

/** Whether the open turn is the goal's exact current round — DSH's `isMatchingGoalRound`. */
export function isMatchingGoalRound(turn: readonly SessionEvent[], goal: Pick<GoalView, 'id' | 'revision' | 'roundsStarted'>): boolean {
  return turn.some((event) => {
    const source = userMessageSource(event)?.source
    return (
      isRecord(source) &&
      source.kind === 'goal' &&
      source.goalId === goal.id &&
      source.revision === goal.revision &&
      source.round === goal.roundsStarted
    )
  })
}

/** Who authorised a `complete` or `blocked`. */
export type CompletionAuthority = { readonly kind: 'direct-human' } | { readonly kind: 'goal-round'; readonly goal: GoalView }

/** What one call reads to decide its authority, read once per call. */
interface CallFacts {
  readonly turn: readonly SessionEvent[]
  readonly meta: { readonly delegationDepth?: unknown } | undefined
}

function factsOf(goals: GoalService, session: SessionHandle): CallFacts {
  return { turn: openTurnEvents(goals.sessionEvents(session)), meta: goals.sessionMeta(session) }
}

function requireDirectHuman(facts: CallFacts): void {
  if (hasDirectHumanInput(facts.turn, facts.meta)) return
  reject(GOAL_TOOL_MESSAGES.humanRequired)
}

function completionAuthority(goals: GoalService, session: SessionHandle, facts: CallFacts): CompletionAuthority {
  if (hasDirectHumanInput(facts.turn, facts.meta)) return { kind: 'direct-human' }
  const goal = goals.get(session)
  if (goal !== undefined && isMatchingGoalRound(facts.turn, goal)) return { kind: 'goal-round', goal }
  return reject(GOAL_TOOL_MESSAGES.completionAuthority)
}

/**
 * Whether an optional argument was really given.
 *
 * DSH's filler rule (dsh-tool-goal:205-211): a strict schema makes some models fill every optional field, so an
 * empty string or 0 counts as omitted. A JSON `null` is treated the same way, because heddle's registry does not
 * validate types and `String(null)` would otherwise become an objective.
 */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== 0
}

/** The exact compare-and-set ref from the model's arguments — DSH's `goalRef`. */
function goalRef(goalId: unknown, revision: unknown): { readonly id: string; readonly revision: number } {
  const id = typeof goalId === 'string' ? goalId : ''
  const number = typeof revision === 'number' ? revision : typeof revision === 'string' && revision.trim() !== '' ? Number(revision) : Number.NaN
  if (id.length === 0 || id !== id.trim() || !Number.isSafeInteger(number) || number < 1) {
    reject(GOAL_TOOL_MESSAGES.badRef, 'GOAL_TOOL_INVALID_UPDATE')
  }
  return { id, revision: number }
}

/** The verb the call names, its legacy spelling resolved; anything else is refused before it runs. */
function actionOf(value: unknown): UpdateAction {
  const action = typeof value === 'string' ? value : ''
  if ((UPDATE_ACTIONS as readonly string[]).includes(action)) return action as UpdateAction
  /** A map, not an object literal: `toString` or `__proto__` must not resolve to a verb. */
  const legacy = LEGACY_ACTIONS.get(action)
  if (legacy !== undefined) return legacy
  return reject(`unknown goal action ${JSON.stringify(String(value ?? ''))}`, 'GOAL_TOOL_UNKNOWN_ACTION')
}

/** The wire shape a model sees; the durable shape plus round and activation, which the model needs too. */
function viewOf(view: GoalView): Record<string, unknown> {
  return {
    id: view.id,
    revision: view.revision,
    objective: view.objective,
    phase: view.phase,
    activation: view.activation,
    roundsStarted: view.roundsStarted,
    maxGoalRounds: view.maxGoalRounds,
    ...(view.blockedReason !== undefined ? { blockedReason: view.blockedReason } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  }
}

/** Turn a refusal into the tool-result shape, keeping the stable code. */
function refused(error: unknown): ToolResult {
  if (error instanceof GoalError || error instanceof GoalToolRefusal) return { output: '', error: { code: error.code, message: error.message } }
  return { output: '', error: { code: 'GOAL_TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
}

/** The session a goal belongs to, or a refusal: a goal is per session, never global. */
function sessionOf(context: ToolContext): { readonly ok: true; readonly session: NonNullable<ToolContext['session']> } | { readonly ok: false; readonly result: ToolResult } {
  if (context.session === undefined) {
    return { ok: false, result: { output: '', error: { code: 'GOAL_TOOL_NO_SESSION', message: 'a goal belongs to a session, and this call has none' } } }
  }
  return { ok: true, session: context.session }
}

/**
 * The closing instruction a goal round reads after its own `complete` or `blocked` — DSH's `renderWrapupContext`,
 * verbatim. DSH defers it as a user message after the tool result; heddle appends it to the result.
 */
export function endOfRun(objective: string, blockedReason?: string): string {
  const heading = `Objective: ${JSON.stringify(objective)}\n`
  if (blockedReason === undefined) {
    return (
      '<goal_complete>\n' +
      heading +
      "The goal is marked complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Note anything the user should review or do next. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_complete>"
    )
  }
  return (
    '<goal_blocked>\n' +
    heading +
    `Blocked: ${JSON.stringify(blockedReason)}\nThe goal is marked blocked and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue. Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_blocked>`
  )
}

/** The three goal tools, bound to one goal service. */
export function goalTools(goals: GoalService, config: GoalToolConfig = {}): ToolDefinition[] {
  const { blockedAfterConsecutiveRounds } = resolveGoalToolConfig(config)
  return [
    {
      spec: {
        name: 'create_goal',
        description: CREATE_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: 'The concrete completion objective inferred from the direct human request.' },
            max_goal_rounds: { type: 'integer', description: 'Optional cap on automatic continuation rounds. Defaults to 100; name a number only when the owner asked for one.' },
          },
          required: ['objective'],
          additionalProperties: false,
        },
      },
      run: async (args, context): Promise<ToolResult> => {
        const resolved = sessionOf(context)
        if (!resolved.ok) return resolved.result
        try {
          requireDirectHuman(factsOf(goals, resolved.session))
          const view = goals.create(resolved.session, {
            objective: String(args.objective ?? ''),
            ...(args.max_goal_rounds !== undefined ? { maxGoalRounds: Number(args.max_goal_rounds) } : {}),
          })
          return { output: JSON.stringify(viewOf(view)), data: { goal: view } }
        } catch (error) {
          return refused(error)
        }
      },
    },
    {
      spec: { name: 'get_goal', description: GET_DESCRIPTION, parameters: { type: 'object', properties: {}, additionalProperties: false } },
      run: async (_args, context): Promise<ToolResult> => {
        const resolved = sessionOf(context)
        if (!resolved.ok) return resolved.result
        const view = goals.get(resolved.session)
        return view === undefined ? { output: 'no goal is current in this session', data: { goal: null } } : { output: JSON.stringify(viewOf(view)), data: { goal: view } }
      },
    },
    {
      spec: {
        name: 'update_goal',
        description: UPDATE_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            goal_id: { type: 'string', description: 'Exact id returned by get_goal.' },
            revision: { type: 'integer', description: 'Exact positive revision returned by get_goal.' },
            action: { type: 'string', enum: [...UPDATE_ACTIONS], description: ACTION_DESCRIPTION },
            objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
            max_goal_rounds: { type: 'integer', description: 'Replacement cap; valid only with action edit.' },
            blocked_reason: {
              type: 'string',
              description: 'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.',
            },
          },
          required: ['goal_id', 'revision', 'action'],
          additionalProperties: false,
        },
      },
      run: async (args, context): Promise<ToolResult> => {
        const resolved = sessionOf(context)
        if (!resolved.ok) return resolved.result
        const session = resolved.session
        try {
          /** The order is DSH's: the verb (its schema), the ref, then authority before the per-verb fields. */
          const action = actionOf(args.action)
          const ref = goalRef(args.goal_id, args.revision)
          const objective = given(args.objective) ? String(args.objective) : undefined
          const maxGoalRounds = given(args.max_goal_rounds) ? Number(args.max_goal_rounds) : undefined
          const reason = args.blocked_reason
          const facts = factsOf(goals, session)

          if (action === 'edit') {
            requireDirectHuman(facts)
            if (given(reason)) reject(GOAL_TOOL_MESSAGES.reasonOnlyWithBlocked, 'GOAL_TOOL_INVALID_UPDATE')
            const view = goals.edit(session, ref, {
              ...(objective !== undefined ? { objective } : {}),
              ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
            })
            return { output: JSON.stringify(viewOf(view)), data: { goal: view } }
          }

          if (action === 'pause' || action === 'resume') {
            requireDirectHuman(facts)
            if (objective !== undefined || maxGoalRounds !== undefined || given(reason)) {
              reject(GOAL_TOOL_MESSAGES.pauseResumeFields, 'GOAL_TOOL_INVALID_UPDATE')
            }
            if (action === 'resume') {
              /**
               * A paused goal is the person's decision to stop: a model that could undo it would make the pause
               * meaningless, even inside a person's turn. Re-arming an active-but-disarmed goal, or resuming a
               * blocked one, is allowed when a person asks.
               */
              const current = goals.get(session)
              if (current !== undefined && current.id === ref.id && current.revision === ref.revision && current.phase === 'paused') {
                reject(GOAL_TOOL_MESSAGES.resumePaused, 'GOAL_TOOL_RESUME_PAUSED')
              }
            }
            const view = action === 'pause' ? goals.pause(session, ref) : goals.resume(session, ref)
            return { output: JSON.stringify(viewOf(view)), data: { goal: view } }
          }

          const authority = completionAuthority(goals, session, facts)
          if (objective !== undefined || maxGoalRounds !== undefined) reject(GOAL_TOOL_MESSAGES.fieldsOnlyWithEdit, 'GOAL_TOOL_INVALID_UPDATE')
          if (action === 'complete' && given(reason)) reject(GOAL_TOOL_MESSAGES.reasonOnlyWithBlocked, 'GOAL_TOOL_INVALID_UPDATE')
          if (action === 'blocked' && (typeof reason !== 'string' || reason.trim().length === 0)) {
            reject(GOAL_TOOL_MESSAGES.reasonRequired, 'GOAL_TOOL_INVALID_UPDATE')
          }
          if (action === 'blocked' && authority.kind === 'goal-round' && authority.goal.roundsStarted < blockedAfterConsecutiveRounds) {
            reject(GOAL_TOOL_MESSAGES.blockThreshold(blockedAfterConsecutiveRounds, authority.goal.roundsStarted), 'GOAL_TOOL_BLOCK_THRESHOLD')
          }
          /** The domain keeps DSH's shape for a model's report: `{ code: 'model-reported', message }`, trimmed. */
          const message = action === 'blocked' ? (reason as string).trim() : undefined
          const view = message === undefined ? goals.complete(session, ref) : goals.block(session, ref, { code: 'model-reported', message })
          /** Only a goal round is told to end its run; a person's own verb ends nothing (DSH defers it only then). */
          const closing = authority.kind === 'goal-round' ? `\n\n${endOfRun(view.objective, message)}` : ''
          return { output: `${JSON.stringify(viewOf(view))}${closing}`, data: { goal: view, authority: authority.kind } }
        } catch (error) {
          return refused(error)
        }
      },
    },
  ]
}
