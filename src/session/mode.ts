import { isSandboxMode, type SandboxMode } from '../sandbox/service.ts'
import type { SessionEvent } from './store.ts'

/**
 * A session's access mode, recorded as one append-only event.
 *
 * DSH keeps `sandbox/mode` as a log-only event and folds it over the deployment default; this is the same
 * mechanism with heddle's names. The reasons the log is the right home are the ones the store already
 * guarantees: an event is written before the switch takes effect, survives a restart by replay, belongs to
 * exactly one session, and reaches every window through the `session/event` stream the store already emits.
 *
 * The record is log-only in the strongest sense: it is **not** a message-producing event, so it takes no
 * surface position and never travels to a model as part of the conversation.
 */

/** The event type one mode change appends. */
export const MODE_EVENT = 'permission/mode'

/**
 * The mode a log records, or `undefined` when it records none.
 *
 * The last event wins, because a session's later choice is its current one. A recorded word outside the
 * closed vocabulary is **not** ignored: it throws, naming the event, because silently falling back to the
 * default would run a session under a policy nobody chose and make a corrupt log look healthy.
 */
export function recordedMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== MODE_EVENT) continue
    if (isSandboxMode(event.mode)) return event.mode
    throw new Error(
      `session event ${event.seq} records access mode '${String(event.mode)}', which is not one of the sandbox modes`,
    )
  }
  return undefined
}

/** The mode a call runs under: the session's last record, or the deployment default when it has none. */
export function effectiveMode(events: readonly SessionEvent[], fallback: SandboxMode): SandboxMode {
  return recordedMode(events) ?? fallback
}
