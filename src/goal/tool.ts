import type { ToolContext, ToolDefinition, ToolResult } from '../tools/service.ts'
import { GoalError, type GoalService, type GoalView } from './service.ts'

/**
 * The model-facing goal tools, modelled on DSH's `dsh-tool-goal`.
 *
 * Three tools rather than one, and the split is the point:
 *
 * - `create_goal` — a long-running request becomes a persisted goal. DSH's own description says the
 *   intent may be **inferred** from the request in any language, and that single-turn work is not a goal.
 * - `get_goal` — read the current goal, including the `id` and `revision` every mutation needs.
 * - `update_goal` — edit, pause, resume, complete or block, each a compare-and-set against that ref.
 *
 * Two policies live here, in the descriptions where a model actually reads them, because the service
 * cannot know them: a **paused** goal is resumed by the person, not the model; and a goal is marked
 * blocked only after the same condition has persisted across rounds. Completing or blocking is an honest
 * end to the run rather than a status change, which is why the tool's answer says so explicitly.
 */

const CREATE_DESCRIPTION =
  'Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.'

const GET_DESCRIPTION = 'Read the current session goal, including the id and revision that update_goal requires.'

const UPDATE_DESCRIPTION =
  'Update the current goal: change its objective or round cap, pause it, resume it, mark it complete, or mark it blocked with a reason. Completion and blocking end the autonomous run.'

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
  if (error instanceof GoalError) return { output: '', error: { code: error.code, message: error.message } }
  return { output: '', error: { code: 'GOAL_TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }
}

/** The session a goal belongs to, or a refusal: a goal is per session, never global. */
function sessionOf(context: ToolContext): { readonly ok: true; readonly session: NonNullable<ToolContext['session']> } | { readonly ok: false; readonly result: ToolResult } {
  if (context.session === undefined) {
    return { ok: false, result: { output: '', error: { code: 'GOAL_TOOL_NO_SESSION', message: 'a goal belongs to a session, and this call has none' } } }
  }
  return { ok: true, session: context.session }
}

/** Rounds the model is reminded of when it completes or blocks: this is what ends the run. */
function endOfRun(view: GoalView, blocked: boolean): string {
  const heading = `Objective: ${JSON.stringify(view.objective)}\n`
  if (blocked) {
    const reason = view.blockedReason !== undefined ? JSON.stringify(view.blockedReason) : '{}'
    return `${heading}Blocked: ${reason}\nThe goal is marked blocked and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue.`
  }
  return `${heading}The goal is marked complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results.`
}

/** The three goal tools, bound to one goal service. */
export function goalTools(goals: GoalService): ToolDefinition[] {
  return [
    {
      spec: {
        name: 'create_goal',
        description: CREATE_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: 'The concrete completion objective inferred from the direct human request.' },
            max_goal_rounds: { type: 'integer', description: 'Optional cap on automatic continuation rounds.' },
          },
          required: ['objective'],
          additionalProperties: false,
        },
      },
      run: async (args, context): Promise<ToolResult> => {
        const resolved = sessionOf(context)
        if (!resolved.ok) return resolved.result
        try {
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
            goal_id: { type: 'string', description: 'The goal id returned by get_goal.' },
            revision: { type: 'integer', description: 'The exact positive revision returned by get_goal.' },
            action: { type: 'string', enum: ['update', 'pause', 'resume', 'complete', 'blocked'], description: 'What to do with the goal.' },
            objective: { type: 'string', description: 'For "update": the new objective.' },
            max_goal_rounds: { type: 'integer', description: 'For "update": the new round cap.' },
            blocked_reason: {
              type: 'object',
              description: 'For "blocked": the stable code and the message a person reads.',
              properties: { code: { type: 'string' }, message: { type: 'string' } },
              required: ['code', 'message'],
              additionalProperties: false,
            },
          },
          required: ['goal_id', 'revision', 'action'],
          additionalProperties: false,
        },
      },
      run: async (args, context): Promise<ToolResult> => {
        const resolved = sessionOf(context)
        if (!resolved.ok) return resolved.result
        const ref = { id: String(args.goal_id ?? ''), revision: Number(args.revision) }
        const action = String(args.action ?? '')
        try {
          if (action === 'resume') {
            /**
             * A paused goal is the person's decision to stop: a model that could undo it would make the
             * pause meaningless. Re-arming an active-but-disarmed goal is allowed, because that is what a
             * session-start edge leaves behind and no person was asked.
             */
            const current = goals.get(resolved.session)
            if (current !== undefined && current.id === ref.id && current.revision === ref.revision && current.phase === 'paused') {
              return { output: '', error: { code: 'GOAL_TOOL_RESUME_PAUSED', message: 'the model cannot resume a paused goal; the user must resume it' } }
            }
          }
          const view =
            action === 'pause'
              ? goals.pause(resolved.session, ref)
              : action === 'resume'
                ? goals.resume(resolved.session, ref)
                : action === 'complete'
                  ? goals.complete(resolved.session, ref)
                  : action === 'blocked'
                    ? goals.block(resolved.session, ref, args.blocked_reason as { code: string; message: string })
                    : action === 'update'
                      ? goals.edit(resolved.session, ref, {
                          ...(args.objective !== undefined ? { objective: String(args.objective) } : {}),
                          ...(args.max_goal_rounds !== undefined ? { maxGoalRounds: Number(args.max_goal_rounds) } : {}),
                        })
                      : undefined
          if (view === undefined) {
            return { output: '', error: { code: 'GOAL_TOOL_UNKNOWN_ACTION', message: `unknown goal action ${JSON.stringify(action)}` } }
          }
          const ended = action === 'complete' || action === 'blocked'
          return { output: `${JSON.stringify(viewOf(view))}${ended ? `\n\n${endOfRun(view, action === 'blocked')}` : ''}`, data: { goal: view } }
        } catch (error) {
          return refused(error)
        }
      },
    },
  ]
}
