import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { runTurn } from '../agent/loop.ts'
import { SubagentError, SubagentService, type SettlementNotice } from '../agent/subagent.ts'
import type { TurnRegistry } from '../agent/turns.ts'
import type { SessionEvent, SessionHandle } from '../session/store.ts'
import { subagentTools } from '../tools/subagent.ts'

/** Name this plugin is registered and logged under. */
export const name = 'subagent-tool'

/**
 * A child turn needs everything a turn needs; the session store and the model are what the child is created
 * with, so they are declared rather than assumed.
 */
export const inject = ['tools', 'session', 'model', 'sandbox', 'context']

export interface Config {
  /** Deepest allowed delegation chain. */
  readonly maxDepth?: number
  /** How many children may be in flight at once. */
  readonly maxActive?: number
}

export const Config: Schema<Config> = Schema.object({
  maxDepth: Schema.number().default(2),
  maxActive: Schema.number().default(1),
})

/** Did the session's model see this event? True once a model request follows it. */
function answeredAfter(events: readonly SessionEvent[], seq: number): boolean {
  return events.some((event) => event.seq > seq && event.type === 'model/request')
}

/**
 * Register the delegation tool and the background-delegation service.
 *
 * The runner is `runTurn` itself: a child is a normal turn in a normal session, which is what keeps the child's
 * context, tools and budget on the same code path as the parent's rather than in a second implementation.
 *
 * A settled child's notice reaches its parent the way team mail reaches a member: written into a **running**
 * turn, which notices new input between rounds (DSH's steering), or, when the parent is idle, as the prompt of a
 * new parent turn. The loop's last look for new input comes just before it ends, so a notice written in that
 * window would sit unanswered; the deliverer waits for the parent to go idle, checks, and answers it with a turn
 * of its own if the ending turn missed it. Deliveries to one parent run one at a time.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const store = ctx.session.store
  const turnFor = async (session: SessionHandle, prompt: string, extra: Partial<Parameters<typeof runTurn>[1]> = {}): Promise<void> => {
    const meta = ctx.session.list().find((one) => one.id === session.id)
    const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
    if (endpoint === undefined) throw new SubagentError('no endpoint is configured for a subagent run', 'SUBAGENT_FAILED')
    await runTurn(ctx, {
      session,
      endpoint,
      prompt,
      ...(meta?.model !== undefined ? { model: meta.model } : {}),
      ...extra,
    })
  }

  const wake = (parent: SessionHandle, notice: SettlementNotice, answerPending: boolean): Promise<void> => {
    const [first, ...rest] = notice.content
    return turnFor(parent, first?.text ?? notice.source.summary, {
      attachments: rest,
      source: notice.source,
      /** A turn a notice started, distinguishable by a backend that cares, as a teammate's turn is (`team`). */
      purpose: 'subagent-notice',
      ...(answerPending ? { answerPending: true } : {}),
    })
  }

  const deliverNow = async (parent: SessionHandle, notice: SettlementNotice): Promise<void> => {
    const turns = ctx.get('turns') as TurnRegistry | undefined
    if (turns?.isRunning(parent.id) === true) {
      const event = store.message(parent, { role: 'user', content: [...notice.content], source: notice.source })
      await turns.whenIdle(parent.id)
      if (answeredAfter(store.read(parent), event.seq)) return
      await wake(parent, notice, true)
      return
    }
    await wake(parent, notice, false)
  }

  const tails = new Map<string, Promise<void>>()
  const service = new SubagentService(
    {
      store,
      /** A child's turn is tagged `subagent`, so a scripted check can give the child a script of its own. */
      run: (child, prompt, signal) => turnFor(child, prompt, { purpose: 'subagent', ...(signal !== undefined ? { signal } : {}) }),
      deliver: (parent, notice) => {
        const previous = tails.get(parent.id) ?? Promise.resolve()
        const next = previous.then(
          () => deliverNow(parent, notice),
          () => deliverNow(parent, notice),
        )
        const tail = next.then(
          () => undefined,
          () => undefined,
        )
        tails.set(parent.id, tail)
        void tail.then(() => {
          if (tails.get(parent.id) === tail) tails.delete(parent.id)
        })
        return next
      },
    },
    { maxDepth: config.maxDepth ?? 2, maxActive: config.maxActive ?? 1 },
  )

  /** Cordis requires a service name to be declared before it can be assigned. */
  ctx.provide('subagents')
  ctx.set('subagents', service)
  for (const tool of subagentTools(service)) {
    ctx.tools.register(tool)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentService
  }
}
