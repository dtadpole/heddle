import { Service, type Context } from '@deepseek-ai/cordis'

import type { CommandDefinition } from '../commands/registry.ts'
import type { GenerateRequest } from '../llm/types.ts'
import type { SessionHandle } from '../session/store.ts'
import type { PlanRouteHost } from './http.ts'
import { planActive, setPlanMode, type PlanLog } from './mode.ts'
import { withPlanPolicy } from './policy.ts'
import { PLAN_REVIEW, exitPlanModeTool, type PlanReviewChannel } from './tool.ts'

export const name = 'plan'

/**
 * `/plan`: enter plan mode, leave it with `/plan off`, or enter it and hand a message to the model.
 *
 * DSH's command and sentences. heddle appends the mode event at once and every request reads the log, so a change made
 * while a turn runs is picked up by that turn's next model call — DSH's "applies from the next step" without a pending
 * state to keep. The words after `/plan` (anything but `off`) become a `prompt` action: the page sends them as the
 * ordinary message DSH steers into the session.
 */
export function planCommand(log: PlanLog): CommandDefinition {
  return {
    name: 'plan',
    label: 'Plan',
    section: 'add',
    description: 'Enter or leave plan mode',
    input: { hint: '[off|message]', attachments: true },
    handler: ({ session, args }) => {
      if (args === 'off') {
        return setPlanMode(log, session, false) === 'committed'
          ? { kind: 'success', text: 'Plan mode off.' }
          : { kind: 'success', text: 'Plan mode is already inactive.' }
      }
      setPlanMode(log, session, true)
      return {
        kind: 'success',
        text: 'Plan mode on. Use /plan off to leave.',
        ...(args.length > 0 ? { action: { kind: 'prompt' as const, text: args } } : {}),
      }
    },
  }
}

/**
 * A request as it leaves for the model: with the plan-mode section when its session is in plan mode, unchanged when
 * it names no session, an unknown one, or one in the default mode.
 */
export function applyPlanPolicy(
  store: { open(id: string): SessionHandle | null; read(handle: SessionHandle): ReturnType<PlanLog['read']> },
  request: GenerateRequest,
): GenerateRequest {
  const id = request.sessionId
  if (id === undefined) return request
  const handle = store.open(id)
  if (handle === null || !planActive(store.read(handle))) return request
  return withPlanPolicy(request)
}

/**
 * The `plan` service: the mode's fold, the `/plan` command, the `plan:policy` section on every request of a session in
 * plan mode, and `exit_plan_mode`.
 */
export class PlanService extends Service {
  readonly log: PlanLog
  /** What `GET /api/sessions/{id}/plan` reads (`http.ts`). */
  readonly routes: PlanRouteHost

  constructor(ctx: Context) {
    super(ctx, 'plan')
    const store = ctx.session.store
    this.log = {
      read: (handle) => store.read(handle),
      append: (handle, event, options) => store.append(handle, event, options ?? {}),
    }

    this.routes = { open: (id) => store.open(id), active: (handle) => this.active(handle) }

    ctx.commands.registry.register(planCommand(this.log))

    /** The section rides every request of a session in plan mode, whichever loop sent it. */
    ctx.on('model/request', (request, next) => applyPlanPolicy(store, next()))

    ctx.tools.register(
      exitPlanModeTool({
        active: (handle) => this.active(handle),
        leave: (handle) => {
          setPlanMode(this.log, handle, false)
        },
        channel: () => reviewChannel(ctx),
      }),
    )
  }

  /** Whether a session is in plan mode. */
  active(handle: SessionHandle): boolean {
    return planActive(this.log.read(handle))
  }
}

/**
 * The plan-review channel: the user-question service (developer-eleven's `questions`) when it is loaded.
 *
 * Agreed with developer-eleven on 2026-10-29 (option b): the question service stays free of plan semantics and this
 * side asks its public `ask` the one `plan-review` question (`questionsReviewChannel`).
 */
function reviewChannel(ctx: Context): PlanReviewChannel | undefined {
  const questions = ctx.get('questions') as QuestionAsker | undefined
  return questions !== undefined && typeof questions.ask === 'function' ? questionsReviewChannel(questions) : undefined
}

/** The part of the question service the review uses: `ask(handle, questions, {timeout, signal})`. */
export interface QuestionAsker {
  ask(
    handle: SessionHandle,
    questions: unknown,
    options: { readonly timeout?: unknown; readonly signal?: AbortSignal },
  ): Promise<
    | { readonly kind: 'answered'; readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] }
    | { readonly kind: 'pending'; readonly callId: string }
  >
}

/**
 * The plan review as one question to the person (DSH's `plan-review`), with the plan under the question.
 *
 * Approve approves; Keep planning, or anything typed, keeps planning with the typed words as the feedback; a skip is a
 * dismissal (plan mode stays on). The wait never runs out (`timeout: -1`), so a `pending` answer cannot happen; if it
 * did, it is read as a dismissal — the safe outcome, because it leaves plan mode on. A stop rejects, and the rejection
 * reaches the turn as the stop it is.
 */
export function questionsReviewChannel(questions: QuestionAsker): PlanReviewChannel {
  return {
    review: async (session, plan, signal) => {
      const outcome = await questions.ask(
        session,
        [
          {
            id: PLAN_REVIEW.id,
            header: PLAN_REVIEW.header,
            question: `${PLAN_REVIEW.question}\n\n${plan.markdown}`,
            options: [
              { label: PLAN_REVIEW.approve.label, description: PLAN_REVIEW.approve.description },
              { label: PLAN_REVIEW.keepPlanning.label, description: PLAN_REVIEW.keepPlanning.description },
            ],
          },
        ],
        { timeout: -1, ...(signal !== undefined ? { signal } : {}) },
      )
      if (outcome.kind !== 'answered') return { kind: 'dismissed' }
      const answer = outcome.answers.find((entry) => entry.id === PLAN_REVIEW.id) ?? outcome.answers[0]
      const custom = answer?.custom?.trim() ?? ''
      const selected = answer?.selected ?? []
      if (custom === '' && selected.includes(PLAN_REVIEW.approve.label)) return { kind: 'approve' }
      if (custom !== '' || selected.includes(PLAN_REVIEW.keepPlanning.label)) return { kind: 'keep-planning', feedback: custom }
      return { kind: 'dismissed' }
    },
  }
}

/** The plan plugin, loaded by the profile. */
export default class PlanPlugin extends PlanService {
  static readonly inject = ['session', 'commands', 'tools']
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['plan']`. */
    plan: PlanService
  }
}
