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

  /**
   * The driver is a **reconciler**: an edge only says "the state may have changed", and the same pure
   * condition decides. That is why there are several edges and why none of them carries meaning:
   *
   * - `turn/completed` — a turn settled, so the session is idle and a round may be started;
   * - `goal/change` **while the session is at rest** — a goal was created, edited, resumed, paused, completed
   *   or cleared by a person or by the API. Without this edge, a goal resumed while idle would wait for a
   *   turn that may never come, which is the fragility of an event-only trigger;
   * - `goal/change` **during a turn** is ignored here on purpose: the running turn must not have a second
   *   turn started inside it, and its own completion edge will re-evaluate the condition.
   *
   * The idle half is read from the log because heddle has no agent-status field: a turn's own events mark
   * the session busy, `turn/completed` marks it idle again. It is the equivalent of DSH's
   * `agent.status === 'idle'` in `readyToDrive`.
   *
   * A turn that ended **abnormally** is no edge (DSH's dsh-goal-round-driver: "Cancellation never auto-restarts a
   * round"; "No abnormal auto-retry — transient provider and persistence failures require a later
   * human-authorized resume"). Abnormal is a `turn/completed` that says `stopped` or names an `error`, which every
   * failed or stopped turn writes since d9443684. Without this, a failing provider chained goal rounds up to the
   * cap: the chain itself stops on a failed round ('turn-failed'), and the failed turn's completion started a new
   * chain. The goal stays as it is; a person's next turn or a goal change is the edge that may continue it.
   */
  const inTurn = new Set<string>()
  const requestFor = (session: string): void => {
    const handle = ctx.session.store.open(session)
    if (handle === null) return
    void driver.request(handle).catch((error: unknown) => {
      ctx.logger.warn('goal driver: %s', error instanceof Error ? error.message : String(error))
    })
  }
  ctx.on('session/event', ({ session, event }) => {
    if (event.type === 'turn/completed') {
      inTurn.delete(session)
      const ended = event as { stopped?: unknown; error?: unknown }
      if (ended.stopped === true || ended.error !== undefined) return
      requestFor(session)
      return
    }
    /**
     * Events a turn writes. `model/request` is the loop's own marker before every model call, so a turn is
     * known to be in flight from its first model call to its completion.
     */
    if (event.type === 'model/request' || event.type === 'assistant/chunk' || event.type === 'turn/retry' || event.type === 'tool/result') {
      inTurn.add(session)
      return
    }
    if (event.type === 'goal/change' && !inTurn.has(session)) requestFor(session)
  })
}
