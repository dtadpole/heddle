import type { SessionHandle } from '../session/store.ts'
import type { ToolDefinition, ToolResult } from '../tools/service.ts'

/**
 * `exit_plan_mode`: the model presents its finished plan for review, and on approval the session leaves plan mode.
 *
 * DSH's tool, re-read from `dsh-plan-mode` on 2026-10-29, with its name, description, parameter and refusals. It is
 * always registered — the catalog stays the same across modes — and refuses outside plan mode, without a `#` heading,
 * and when no review channel exists. The review itself is a question to the person (`plan-review`: Approve / Keep
 * planning), asked through the session's user-question channel; heddle's channel is the question tool's
 * (developer-eleven), and until it is loaded the tool answers with DSH's own sentence telling the model to ask the
 * person to switch the mode by hand.
 */

export const EXIT_PLAN_MODE = 'exit_plan_mode'

export const EXIT_DESCRIPTION =
  "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again."

/** The review question, as DSH asks it. */
export const PLAN_REVIEW = {
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  approve: { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
  keepPlanning: { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
} as const

/** What the person decided. */
export type PlanReviewAnswer =
  | { readonly kind: 'approve' }
  | { readonly kind: 'keep-planning'; readonly feedback: string }
  /** The person closed the review to answer in their own words; plan mode stays on. */
  | { readonly kind: 'dismissed' }

/** Where a plan is reviewed: the session's user-question channel. */
export interface PlanReviewChannel {
  review(session: SessionHandle, plan: { readonly title: string; readonly markdown: string }, signal?: AbortSignal): Promise<PlanReviewAnswer>
}

/** What the tool reads and changes. */
export interface PlanToolHost {
  active(session: SessionHandle): boolean
  leave(session: SessionHandle): void
  /** The review channel, looked up per call; `undefined` while none is loaded. */
  channel(): PlanReviewChannel | undefined
}

/** The plan's first markdown heading (any level), as DSH reads its title. */
export function planTitle(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

function refusal(code: string, message: string): ToolResult {
  return { output: '', error: { code, message } }
}

export function exitPlanModeTool(host: PlanToolHost): ToolDefinition {
  return {
    spec: {
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: 'The complete plan, as markdown, starting with a # heading that names it.' },
        },
        required: ['plan'],
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const session = context.session
      if (session === undefined) return refusal('PLAN_NO_SESSION', `${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`)
      if (!host.active(session)) return refusal('PLAN_NOT_ACTIVE', `${EXIT_PLAN_MODE} is only available in plan mode`)
      const plan = typeof args.plan === 'string' ? args.plan : ''
      if (!/^#\s+\S/.test(plan.trim())) {
        return refusal('PLAN_NO_HEADING', `${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`)
      }
      const channel = host.channel()
      if (channel === undefined) {
        return refusal('PLAN_NO_REVIEW_CHANNEL', 'no user-questions channel is available to review the plan; ask the user to switch the session mode instead')
      }
      const answer = await channel.review(session, { title: planTitle(plan) ?? 'Plan', markdown: plan.trim() }, context.signal)
      if (answer.kind === 'approve') {
        host.leave(session)
        return { output: 'Plan approved — plan mode exited; carry out the plan starting with your next step.', data: { approved: true } }
      }
      if (answer.kind === 'keep-planning') {
        const feedback = answer.feedback.trim()
        return refusal(
          'PLAN_KEEP_PLANNING',
          feedback === '' ? 'The user chose to keep planning; revise the plan and present it again.' : `The user chose to keep planning; their feedback: ${feedback}`,
        )
      }
      return { output: 'The user dismissed the plan review to reply in their own words; plan mode remains active.', data: { approved: false } }
    },
  }
}
