import { GoalError, type GoalRef, type GoalView } from '../goal/service.ts'
import type { ContentPart } from '../llm/types.ts'
import type { SessionHandle } from '../session/store.ts'
import type { CommandContext, CommandDefinition, CommandResult } from './registry.ts'

/**
 * `/goal` — set, show, edit, pause, resume or clear the session's goal, as DSH's `dsh-command-goal` does.
 *
 * Read from DSH 0.2.1-rc.2's `@deepseek-ai/dsh-command-goal/lib/index.js` and its extraction in
 * `_projects_/heddle/_designs_/dsh-parity/goals-todo-spec.md` section B1; the line numbers below are that file's.
 * Developer-nine owns these semantics (D-059); the command layer that runs them — the registry, the `command/run`
 * and `command/done` events, the route and the page — is developer-three's (D-057), so section B2 is not here.
 *
 * What a person can type, decided only by {@link parseGoalCommand} (:19-35):
 *
 * - nothing: show the goal, or say none is set;
 * - `clear`, `pause` or `resume`, the **whole** input, in any case: act on the goal;
 * - `edit <objective>`: replace the objective — `edit` alone is refused, and `edit` must be followed by whitespace;
 * - anything else: create a goal whose objective is the whole input, so `/goal pause after verification` sets that
 *   objective rather than pausing. There is no round-cap argument.
 *
 * A person's command carries **no authority checks**: those are the model's tools' (`src/goal/tool.ts`). So `/goal
 * resume` resumes a goal a person paused, and a created goal is armed at once. Every refusal the goal service raises
 * (stale revision, invalid transition, an exhausted cap, a missing goal) is one sentence, {@link GOAL_STATE_ERROR}
 * (:165-171); anything else is not the goal domain's and is thrown on, so the layer records it as the run's error.
 */

/** The usage line every refusal that needs one ends with (:11). */
export const GOAL_USAGE = 'Usage: /goal [<objective>|clear|edit <objective>|pause|resume]'

/** The argument shape the menu shows (:180). */
export const GOAL_INPUT_HINT = '[<objective>|clear|edit <objective>|pause|resume]'

/** The one answer to any refusal from the goal service (:165-171). */
export const GOAL_STATE_ERROR = 'The goal command is not valid for the current state. Run /goal to view available commands.'

/** The refusal of attachments on a form that sets no objective (:111-114). */
export const GOAL_ATTACHMENTS_REFUSED = 'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.'

/** The text that follows a goal objective's attachments in their follow-up message (:101-104). */
export const GOAL_ATTACHMENTS_TEXT = 'Reference attachments for the goal objective.'

/** The goal operations `/goal` drives: the goal service's own methods, with its own view and reference. */
export interface GoalHost {
  get(handle: SessionHandle): GoalView | undefined
  create(handle: SessionHandle, request: { readonly objective: string }): GoalView
  edit(handle: SessionHandle, ref: GoalRef, request: { readonly objective: string }): GoalView
  pause(handle: SessionHandle, ref: GoalRef): GoalView
  resume(handle: SessionHandle, ref: GoalRef): GoalView
  clear(handle: SessionHandle, ref: GoalRef): unknown
}

/** The model-visible user message that carries a goal objective's attachments, DSH's `followup` (:98-107). */
export interface GoalFollowup {
  readonly role: 'user'
  /** The attachments, in the order they came, then {@link GOAL_ATTACHMENTS_TEXT}. */
  readonly content: readonly ContentPart[]
  /** DSH's source: a person's message, which is what the follow-up turn's authority rests on. */
  readonly source: { readonly kind: 'user' }
}

/**
 * Where a goal objective's attachments go: one follow-up message, queued to start a turn after the command.
 *
 * DSH calls `agent.followup(message)` (:100). The command layer offers no such call yet, so the command service
 * passes none and {@link goalCommand} does not deliver the message — see the TODO in {@link submitObjectiveAttachments}.
 */
export type GoalFollowupSink = (session: SessionHandle, message: GoalFollowup) => void

/** `/goal`'s definition: the layer's, with a handler that answers at once. */
export interface GoalCommandDefinition extends CommandDefinition {
  readonly handler: (context: CommandContext) => CommandResult
}

/** One parsed `/goal` line. */
export type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'create'; readonly objective: string }

/** Parse only the grammar `/goal` owns; any other input is an objective (:19-35). */
export function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear') return { kind: 'clear' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'edit') return { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
  return { kind: 'create', objective: input }
}

/** The goal as `/goal` shows it, under a title: DSH's lines, joined by newlines (:59-77). */
export function renderGoal(title: string, goal: GoalView): string {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined
  if (goal.phase === 'blocked' && reason === undefined) throw new TypeError('blocked goal is missing its reason')
  const blocker = reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return [
    title,
    `Status: ${phaseLabel(goal.phase)}`,
    ...blocker,
    `Objective: ${goal.objective}`,
    `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
    `Activation: ${goal.activation}`,
    '',
    `Commands: ${commandHint(goal)}`,
  ].join('\n')
}

/** The commands that mean something from the goal's exact live state (:48-57). */
export function commandHint(goal: Pick<GoalView, 'phase' | 'activation'>): string {
  if (goal.phase === 'active') {
    return goal.activation === 'armed' ? '/goal edit <objective>, /goal pause, /goal clear' : '/goal edit <objective>, /goal resume, /goal clear'
  }
  switch (goal.phase) {
    case 'paused':
    case 'blocked':
      return '/goal edit <objective>, /goal resume, /goal clear'
    case 'complete':
      return '/goal <objective>, /goal clear'
    default:
      return assertNever(goal.phase, 'goal phase')
  }
}

/** The follow-up message for a goal objective's attachments, or `undefined` when there are none (:98-107). */
export function goalAttachmentFollowup(attachments: readonly ContentPart[]): GoalFollowup | undefined {
  if (attachments.length === 0) return undefined
  return { role: 'user', content: [...attachments, { type: 'text', text: GOAL_ATTACHMENTS_TEXT }], source: { kind: 'user' } }
}

/**
 * The `/goal` command over the goal service.
 *
 * Its input accepts attachments, so the layer hands the files sent with the line to the handler as
 * `context.attachments`, already read as message parts. `followup` is where a create's or an edit's attachments go
 * once the goal has changed; when it is absent they go nowhere yet (the TODO in {@link submitObjectiveAttachments}).
 */
export function goalCommand(goals: GoalHost, followup?: GoalFollowupSink): GoalCommandDefinition {
  return {
    name: 'goal',
    label: 'Goal',
    section: 'add',
    description: 'Set or view the goal for a long-running task',
    input: { hint: GOAL_INPUT_HINT, attachments: true },
    handler: (context) => executeGoalCommand(goals, followup, context),
  }
}

/** Run one parsed line, with the attachments the layer read for it, through the goal service, which owns every write (:109-172). */
function executeGoalCommand(goals: GoalHost, followup: GoalFollowupSink | undefined, context: CommandContext): CommandResult {
  const { session, attachments } = context
  const command = parseGoalCommand(context.rawInput)
  if (attachments.length > 0 && command.kind !== 'create' && command.kind !== 'edit') {
    return { kind: 'error', text: GOAL_ATTACHMENTS_REFUSED }
  }
  try {
    const current = goals.get(session)
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: `No goal is currently set.\n${GOAL_USAGE}` }
          : { kind: 'success', text: renderGoal('Goal', current) }
      case 'invalid-edit':
        return { kind: 'error', text: `Goal editing requires a replacement objective.\n${GOAL_USAGE}` }
      case 'create': {
        if (current !== undefined && current.phase !== 'complete') {
          return {
            kind: 'error',
            text: `A goal is already ${phaseLabel(current.phase)}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
          }
        }
        const created = goals.create(session, { objective: command.objective })
        submitObjectiveAttachments(followup, session, attachments)
        return { kind: 'success', text: renderGoal('Goal created', created) }
      }
      case 'edit': {
        if (current === undefined) return missingGoal('edit')
        if (current.phase === 'complete') {
          const replaced = goals.create(session, { objective: command.objective })
          submitObjectiveAttachments(followup, session, attachments)
          return { kind: 'success', text: renderGoal('Goal created', replaced) }
        }
        const edited = goals.edit(session, goalRef(current), { objective: command.objective })
        submitObjectiveAttachments(followup, session, attachments)
        return { kind: 'success', text: renderGoal('Goal updated', edited) }
      }
      case 'pause':
        if (current === undefined) return missingGoal('pause')
        return { kind: 'success', text: renderGoal('Goal paused', goals.pause(session, goalRef(current))) }
      case 'resume':
        if (current === undefined) return missingGoal('resume')
        return { kind: 'success', text: renderGoal('Goal resumed', goals.resume(session, goalRef(current))) }
      case 'clear':
        if (current === undefined) return { kind: 'success', text: 'No goal to clear.' }
        goals.clear(session, goalRef(current))
        return { kind: 'success', text: 'Goal cleared.' }
      default:
        return assertNever(command, 'goal command')
    }
  } catch (error) {
    if (isGoalError(error)) return { kind: 'error', text: GOAL_STATE_ERROR }
    throw error
  }
}

/**
 * Hand a goal objective's attachments on as one follow-up message, after the goal has changed (:98-107).
 *
 * DSH queues the message on the agent, so the next turn reads the attachments from ordinary history and the goal
 * itself stores no attachment state.
 */
function submitObjectiveAttachments(followup: GoalFollowupSink | undefined, session: SessionHandle, attachments: readonly ContentPart[]): void {
  const message = goalAttachmentFollowup(attachments)
  if (message === undefined) return
  // TODO(developer-three, D-057): the command layer has no way yet to start the follow-up turn DSH's
  // `agent.followup` starts. The attachments now reach this handler (`context.attachments`, d98176c9), but nothing a
  // command can reach queues a turn — `CommandAction` is only a download and the service holds no turn starter. Until
  // the command service passes a `followup` sink to `goalCommand`, a create's or an edit's attachments are accepted
  // and the goal changes, but the message is not delivered.
  followup?.(session, message)
}

/** The refusal of an action that needs a current goal (:86-91). A space, not a newline, precedes the usage. */
function missingGoal(action: 'edit' | 'pause' | 'resume'): CommandResult {
  return { kind: 'error', text: `No goal is currently set; /goal ${action} requires one. ${GOAL_USAGE}` }
}

/** The exact compare-and-set reference of the goal just read. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** A durable phase as a person reads it (:37-46). */
function phaseLabel(phase: GoalView['phase']): string {
  switch (phase) {
    case 'active':
      return 'active'
    case 'paused':
      return 'paused'
    case 'blocked':
      return 'blocked'
    case 'complete':
      return 'complete'
    default:
      return assertNever(phase, 'goal phase')
  }
}

/**
 * Whether an error is the goal service's refusal, DSH's `instanceof GoalError` (:166).
 *
 * The name and code are read too, so a second copy of the goal module (a `src` and a `dist` import meeting in one
 * process) is still recognised rather than shown to a person as a raw message.
 */
function isGoalError(error: unknown): boolean {
  if (error instanceof GoalError) return true
  return error instanceof Error && error.name === 'GoalError' && typeof (error as { code?: unknown }).code === 'string'
}

/** Fail loudly if a closed union gains a member this file does not handle. */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
