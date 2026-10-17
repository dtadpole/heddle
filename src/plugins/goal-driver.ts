import type { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../agent/loop.ts'
import { GoalDriver } from '../goal/driver.ts'

/** Name this plugin is registered and logged under. */
export const name = 'goal-driver'

/**
 * A goal round needs everything a turn needs, plus the goal it is continuing. Declaring them here is
 * what keeps the row honest: a profile that leaves, say, the context plugin out does not get a driver
 * that would fail on its first round.
 */
export const inject = ['goal', 'session', 'model', 'tools', 'sandbox', 'context']

/**
 * The driver, triggered by the session's own turn events.
 *
 * DSH triggers its driver at quiescence; heddle's equivalent is the `turn/completed` event every append
 * already emits. Triggering there rather than from the call sites is what lets the Web server, the CLI
 * and any future long-lived process share one behaviour: the driver is the layer that knows a session
 * went idle, and the caller does not have to remember to ask.
 *
 * The listener starts the chain and does not await it — a turn must not be held open by the rounds it
 * starts — so failures are logged. A one-shot process (the CLI) joins the same chain explicitly before
 * it exits, which is the only thing the two callers do differently.
 */
export function apply(ctx: Context): void {
  const driver = new GoalDriver(ctx, ctx.goal, {
    run: async (handle, prompt, source) => {
      const meta = ctx.session.list().find((one) => one.id === handle.id)
      const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
      if (endpoint === undefined) throw new Error('goal round driver: no endpoint is configured')
      return await runTurn(ctx, {
        session: handle,
        endpoint,
        prompt,
        source,
        ...(meta?.model !== undefined ? { model: meta.model } : {}),
      })
    },
  })

  ctx.on('session/event', ({ session, event }) => {
    if (event.type !== 'turn/completed') return
    const handle = ctx.session.store.open(session)
    if (handle === null) return
    void driver.advance(handle).catch((error: unknown) => {
      ctx.logger.warn('goal driver: %s', error instanceof Error ? error.message : String(error))
    })
  })
}
