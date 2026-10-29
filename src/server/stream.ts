import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

/**
 * The live event stream's wire frames, apart from the routes that send them.
 *
 * `GET /api/events` is heddle's counterpart of DSH's internal `$events` stream. DSH opens that stream with one
 * `{ type: 'ready', clientId, host: { home } }` item (dsh-api-gateway README; API Remotes owns the frame), and its
 * Client publishes a connection generation and starts its baseline reads only after that item arrives, because
 * the incremental listeners were attached before it was sent. A baseline read after `ready` therefore cannot miss
 * an increment, and a client can tell an open stream from one that is still connecting.
 *
 * heddle keeps its opening comment (`: heddle stream open`, ignored by every SSE parser) for the readers that
 * already look for it, and sends `ready` as the first event after it. The route registers the subscriber
 * **before** writing `ready`, which is the ordering DSH's source factory guarantees.
 */

/** The comment every stream opens with, before its first event. */
export const STREAM_OPEN = ': heddle stream open\n\n'

/** The event name of the opening frame. */
export const READY_EVENT = 'ready'

/** The opening frame's data, keys in DSH's order. */
export interface ReadyFrame {
  readonly type: 'ready'
  readonly clientId: string
  readonly host: { readonly home: string }
}

/**
 * A client id for one stream: 16 random bytes, hex.
 *
 * One per connection, not per page: a page that reconnects gets a new one, which is how a server or a check
 * tells a reconnect from the same stream continuing. The Rust server mints the same shape.
 */
export function newClientId(): string {
  return randomBytes(16).toString('hex')
}

/** The opening frame's data for one stream. `home` is the Host's home folder, as DSH sends it. */
export function readyData(clientId: string, home: string = homedir()): ReadyFrame {
  return { type: 'ready', clientId, host: { home } }
}

/** The opening frame as it goes on the wire: `event: ready` and one line of JSON. */
export function readyFrame(clientId: string, home: string = homedir()): string {
  return `event: ${READY_EVENT}\ndata: ${JSON.stringify(readyData(clientId, home))}\n\n`
}
