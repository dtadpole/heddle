import { Service, type Context } from '@deepseek-ai/cordis'

import type { CommandDefinition } from '../commands/registry.ts'
import type { GenerateRequest } from '../llm/types.ts'
import type { SessionHandle } from '../session/store.ts'
import type { PlanRouteHost } from './http.ts'
import { planActive, setPlanMode, type PlanLog } from './mode.ts'
import { withPlanPolicy } from './policy.ts'
import { exitPlanModeTool, type PlanReviewChannel } from './tool.ts'

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
 * The plan-review channel: the user-question service when one is loaded.
 *
 * heddle's question tool (developer-eleven, `src/questions/`) is not on main yet; a service named `planReview` that
 * answers {@link PlanReviewChannel} is used as soon as one is provided, so the question tool can offer it — or this
 * function can adapt the question service's own API — without changing the tool.
 */
function reviewChannel(ctx: Context): PlanReviewChannel | undefined {
  const channel = ctx.get('planReview') as PlanReviewChannel | undefined
  return channel !== undefined && typeof channel.review === 'function' ? channel : undefined
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
