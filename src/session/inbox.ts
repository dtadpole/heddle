import { randomUUID } from 'node:crypto'

import type { ContentPart } from '../llm/types.ts'
import type { SessionEvent, SessionHandle } from './store.ts'

/**
 * The session's pending input: what a person sent into a running turn that the turn has not taken yet.
 *
 * This is DSH's agent inbox (`dsh-agent-loop`, `ReactLoopInbox`), recorded the way DSH records it. A steer does
 * not write a message. It splices the message into the **next-step** list, and the loop claims the whole list
 * at its next step boundary. A tool call's result is written inside the step that asked for it, so the steered
 * message lands after that result and never between a call and its answer. A stop leaves the list as it is,
 * because DSH's session cancel keeps the inbox (`agent.cancel({ kind: 'user' }, { keepInbox: true })`). The
 * next turn claims what is left before its own prompt, as DSH's boundary claims next-step input first.
 *
 * The list is **durable**. Every change is one `agent/inbox/spliced` event with DSH's fields (`target`,
 * `start`, `removedCount`, `inserted`, `outcome`), and the state is the fold of those events. So a pending
 * steer survives a restart, and every reader of the log sees the same list. Measured before this module
 * existed (R-developer-two-5): a steer sent during `bash sleep 30` was written at seq 6, between the call
 * (seq 4-5) and its result (seq 7), and a stop then left nothing pending.
 *
 * heddle's page keeps its own next-turn queue, so only `next-step` is written here. The fold still reads both
 * lists, so a later queue on the server can use the same event.
 */

/** The event every inbox change is recorded as. DSH's name. */
export const INBOX_SPLICED = 'agent/inbox/spliced'

/** The two pending lists: prompts that each start a turn, and input for the next step of the running one. */
export type InboxTarget = 'next-turn' | 'next-step'

/** One pending message. It is written as an ordinary user message when it is claimed. */
export interface InboxMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly ContentPart[]
  /** Who wrote it, when it was not a person (the same field a recorded message carries). */
  readonly source?: unknown
}

/** The inbox's state: DSH's projection, `{ 'next-turn', 'next-step' }`. */
export interface Inbox {
  readonly 'next-turn': readonly InboxMessage[]
  readonly 'next-step': readonly InboxMessage[]
}

/** The store, narrowed to the two calls the inbox makes. */
export interface InboxStore {
  read(handle: SessionHandle): readonly SessionEvent[]
  append(handle: SessionHandle, event: { readonly type: string; readonly [key: string]: unknown }): SessionEvent
}

const EMPTY: Inbox = { 'next-turn': [], 'next-step': [] }

/**
 * Fold the inbox from a session's events.
 *
 * An invalid splice is refused the way DSH refuses it. That covers a start or count outside the list and a
 * message id that is already pending. The error names the seq, because a log that carries one cannot be read
 * as a list of pending input.
 */
export function foldInbox(events: readonly { readonly seq?: number; readonly type: string; readonly [key: string]: unknown }[]): Inbox {
  let state: Inbox = EMPTY
  for (const event of events) {
    if (event.type !== INBOX_SPLICED) continue
    try {
      const target = event.target
      if (target !== 'next-turn' && target !== 'next-step') throw new Error(`unknown inbox target ${String(target)}`)
      const list = state[target]
      const start = event.start
      const removedCount = event.removedCount ?? 0
      if (
        typeof start !== 'number' ||
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > list.length ||
        typeof removedCount !== 'number' ||
        !Number.isSafeInteger(removedCount) ||
        removedCount < 0 ||
        start + removedCount > list.length
      ) {
        throw new Error('invalid inbox splice')
      }
      const inserted = Array.isArray(event.inserted) ? (event.inserted as InboxMessage[]) : []
      const next = [...list.slice(0, start), ...inserted, ...list.slice(start + removedCount)]
      const other = target === 'next-turn' ? state['next-step'] : state['next-turn']
      const ids = new Set<string>()
      for (const message of [...next, ...other]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      state = target === 'next-turn' ? { 'next-turn': next, 'next-step': state['next-step'] } : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error) {
      throw new Error(`invalid persisted inbox splice at session seq ${String(event.seq)}`, { cause: error })
    }
  }
  return state
}

/** The session's inbox now. */
export function pendingInbox(store: InboxStore, handle: SessionHandle): Inbox {
  return foldInbox(store.read(handle))
}

/** Whether a message waits for the next step boundary. The loop asks this before it ends a turn. */
export function hasPendingStep(store: InboxStore, handle: SessionHandle): boolean {
  return pendingInbox(store, handle)['next-step'].length > 0
}

/**
 * The steer gate (#31): whether the session's running turn still accepts a steer.
 *
 * A turn opens it when it begins, and closes it in the **same tick** as its final "nothing pending" decision
 * (`hasPendingStepOrClose`), so no steer can be queued after the loop stopped looking and before the turn ends.
 * Measured window before (developer-ten's review): the loop's last check ran before the route's own running count
 * dropped, and a steer accepted in between waited in the inbox until the person sent something else. The route
 * answers `session/steer-unavailable` when the gate is shut, and the page queues the message instead (DSH).
 * In memory only: a gate belongs to a live turn of this process.
 */
const steerGates = new WeakMap<InboxStore, Set<string>>()

function steerGate(store: InboxStore): Set<string> {
  let open = steerGates.get(store)
  if (open === undefined) {
    open = new Set()
    steerGates.set(store, open)
  }
  return open
}

/** A turn began on the session: steers are accepted until it ends. */
export function openSteering(store: InboxStore, handle: SessionHandle): void {
  steerGate(store).add(handle.id)
}

/** The turn ended, whichever way: a steer now waits for a turn of its own. */
export function closeSteering(store: InboxStore, handle: SessionHandle): void {
  steerGate(store).delete(handle.id)
}

/** Whether a steer sent now would still be claimed by the running turn. */
export function steeringOpen(store: InboxStore, handle: SessionHandle): boolean {
  return steerGate(store).has(handle.id)
}

/**
 * The loop's end-of-turn question: `true` when a message waits for the next step; otherwise the gate closes in the
 * same tick and the answer is `false`, so nothing can slip in between this decision and the turn's end.
 */
export function hasPendingStepOrClose(store: InboxStore, handle: SessionHandle): boolean {
  if (hasPendingStep(store, handle)) return true
  closeSteering(store, handle)
  return false
}

/**
 * Steer: put a message at the end of the next-step list (DSH's `steer`, `send(message, 'next-step', true)`).
 *
 * Nothing reaches the conversation here. The running loop writes the message at its next step boundary, which
 * is after the result of any tool call still running.
 */
export function queueSteer(store: InboxStore, handle: SessionHandle, content: readonly ContentPart[], source?: unknown): InboxMessage {
  const message: InboxMessage = {
    id: `inbox-${randomUUID()}`,
    role: 'user',
    content: [...content],
    ...(source !== undefined ? { source } : {}),
  }
  const list = pendingInbox(store, handle)['next-step']
  store.append(handle, { type: INBOX_SPLICED, target: 'next-step', start: list.length, inserted: [message] })
  return message
}

/**
 * Claim the whole next-step list at a step boundary and write each message into the conversation.
 *
 * DSH's order: the claim is recorded first (a splice that removes the list, with no `outcome`, because the
 * messages are delivered rather than cancelled), then each message is written as a user message in list order.
 * `write` is the session's own user-message path, so a claimed steer is the same event a typed prompt is.
 * Answers the messages claimed, which is none when nothing waited.
 */
export function claimNextStep(
  store: InboxStore,
  handle: SessionHandle,
  write: (content: readonly ContentPart[], source: unknown) => void,
): readonly InboxMessage[] {
  const claimed = pendingInbox(store, handle)['next-step']
  if (claimed.length === 0) return []
  store.append(handle, { type: INBOX_SPLICED, target: 'next-step', start: 0, removedCount: claimed.length, inserted: [] })
  for (const message of claimed) write(message.content, message.source)
  return claimed
}
