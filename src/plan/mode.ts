import type { SessionEvent, SessionHandle, SurfaceOp } from '../session/store.ts'

/**
 * Plan mode's state: one append-only event per change, folded from the log.
 *
 * DSH's `dsh-plan-mode` keeps `plan/mode {active}` in the session log and folds it, so a mode survives a restart, a
 * resume and a fork without a second store; this is the same event with the same shape. Like `permission/mode` it is
 * log-only — no surface position, never part of the conversation.
 *
 * What the model is told is separate: while plan mode is on, every request carries the policy section
 * (`policy.ts`); and when the mode changes in a session the model has already answered in, a one-line notice is
 * appended to the conversation, DSH's "The user switched this session to plan mode." — so a model that planned
 * yesterday is not surprised to find itself allowed to edit today.
 */

/** The event one change appends. */
export const PLAN_EVENT = 'plan/mode'

/** The origin a mode-change notice is recorded with. */
export const PLAN_NOTICE_ORIGIN = 'plan-mode'

/** DSH's two notices, word for word. */
export const PLAN_ON_NOTICE = 'The user switched this session to plan mode.'
export const PLAN_OFF_NOTICE = 'The user switched this session back to the default mode.'

/** The part of the session store a change reads and writes. */
export interface PlanLog {
  read(handle: SessionHandle): readonly SessionEvent[]
  append(
    handle: SessionHandle,
    event: { readonly type: string; readonly [field: string]: unknown },
    options?: { readonly surfaceOp?: SurfaceOp },
  ): SessionEvent
}

/** Whether a log is in plan mode: its last `plan/mode` event, or off when it has none. */
export function planActive(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === PLAN_EVENT) return event.active === true
  }
  return false
}

/** What a change did: written, or nothing because the session was already in that mode. */
export type PlanChange = 'committed' | 'noop'

/**
 * Switch a session into or out of plan mode.
 *
 * The mode event is written first, then — when the model has answered in this session before — the notice, so the
 * next request both carries (or drops) the policy section and reads why. A change to the mode already in effect
 * writes nothing.
 */
export function setPlanMode(log: PlanLog, handle: SessionHandle, active: boolean): PlanChange {
  const events = log.read(handle)
  if (planActive(events) === active) return 'noop'
  log.append(handle, { type: PLAN_EVENT, active })
  if (events.some((event) => event.type === 'model/request')) {
    log.append(
      handle,
      {
        type: 'context/note',
        message: { role: 'user', content: [{ type: 'text', text: active ? PLAN_ON_NOTICE : PLAN_OFF_NOTICE }] },
        origin: PLAN_NOTICE_ORIGIN,
      },
      { surfaceOp: 'append' },
    )
  }
  return 'committed'
}
