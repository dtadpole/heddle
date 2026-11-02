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

/** The plan a review shows: its title, its markdown, and the `exit_plan_mode` call that presented it when known. */
export interface PlanForReview {
  readonly title: string
  readonly markdown: string
  readonly callId?: string
}

/** Where a plan is reviewed: the session's user-question channel. */
export interface PlanReviewChannel {
  review(session: SessionHandle, plan: PlanForReview, signal?: AbortSignal): Promise<PlanReviewAnswer>
}

/** What the tool reads and changes. */
export interface PlanToolHost {
  active(session: SessionHandle): boolean
  leave(session: SessionHandle): void
  /** The review channel, looked up per call; `undefined` while none is loaded. */
  channel(): PlanReviewChannel | undefined
  /** The id of the open `exit_plan_mode` call presenting `markdown` ({@link openPlanCallId}); absent in a host without a log. */
  callId?(session: SessionHandle, markdown: string): string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `plan` argument of a call's JSON arguments, trimmed; `undefined` when it has none. */
function planArgument(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) && typeof parsed.plan === 'string' ? parsed.plan.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * The id of the newest `exit_plan_mode` call in the log that has no answer yet and presents `markdown` (#231).
 *
 * The loop records each finished call as an `assistant/chunk` of type `tool-call` while the model answers, runs the
 * calls, and only then commits the assistant's `tool_calls` message with the answers. So while the review waits, its call
 * is a recorded `tool-call` chunk with no tool message answering it; a call in a committed message is read the same way.
 * DSH hands the tool its call id (`exec.callId`); heddle's tools are not given theirs, so the review reads it from the
 * log. The plan text must match too, so a review is never linked to some other call. `undefined` when no such call is
 * found; the review is still asked, only without the link.
 */
export function openPlanCallId(events: readonly Record<string, unknown>[], markdown: string): string | undefined {
  const answered = new Set<string>()
  for (const event of events) {
    const message = event.type === 'message' && isRecord(event.message) ? event.message : undefined
    if (message?.role === 'tool' && typeof message.toolCallId === 'string') answered.add(message.toolCallId)
  }
  /** The tool-call parts an event carries: a recorded call chunk's, or an assistant message's. */
  const calls = (event: Record<string, unknown>): readonly unknown[] => {
    if (event.type === 'assistant/chunk' && isRecord(event.chunk) && event.chunk.type === 'tool-call') return [event.chunk]
    const message = event.type === 'message' && isRecord(event.message) ? event.message : undefined
    return message?.role === 'assistant' && Array.isArray(message.content) ? [...message.content].reverse() : []
  }
  for (let at = events.length - 1; at >= 0; at -= 1) {
    for (const part of calls(events[at] as Record<string, unknown>)) {
      if (!isRecord(part) || part.type !== 'tool-call' || part.name !== EXIT_PLAN_MODE || typeof part.id !== 'string') continue
      if (!answered.has(part.id) && planArgument(part.arguments) === markdown) return part.id
    }
  }
  return undefined
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
      const markdown = plan.trim()
      const callId = host.callId?.(session, markdown)
      const answer = await channel.review(session, { title: planTitle(plan) ?? 'Plan', markdown, ...(callId !== undefined ? { callId } : {}) }, context.signal)
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
