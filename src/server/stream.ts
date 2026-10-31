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

/**
 * The heartbeat, and the end of a dead peer.
 *
 * DSH's Host pings every `websocketHeartbeatIntervalMs` (two seconds by default) so idle intermediaries see
 * traffic, and terminates a socket with **no activity across two intervals**, where activity includes "a downlink
 * write that waited in the full local send buffer and then completed", so a congested but live link stays
 * connected (dsh-api-gateway README). An SSE stream has no Pong to read, so heddle keeps the half of that rule a
 * one-way stream can observe: a connection whose written bytes have not moved for two intervals while it still
 * holds unsent data is dead, and is destroyed. A slow but live link keeps moving bytes and is kept.
 *
 * The heartbeat is an event rather than a comment because the page watches for it: a stream that goes silent for
 * two intervals is one the page reconnects (phase B item 3). The Rust server uses the same name, interval and rule.
 */

/** The event name of the heartbeat frame. */
export const HEARTBEAT_EVENT = 'heartbeat'

/** DSH's default `websocketHeartbeatIntervalMs`. */
export const DEFAULT_HEARTBEAT_MS = 2000

/** The heartbeat frame as it goes on the wire. */
export function heartbeatFrame(): string {
  return `event: ${HEARTBEAT_EVENT}\ndata: {"type":"heartbeat"}\n\n`
}

/**
 * The heartbeat interval in milliseconds: `HEDDLE_WEB_HEARTBEAT_MS` when it is a whole number of at least 50,
 * DSH's two seconds otherwise. A deployment whose event loop or network can stall longer than this must raise it,
 * as DSH says of its own setting.
 */
export function heartbeatInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HEDDLE_WEB_HEARTBEAT_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_HEARTBEAT_MS
  const value = Number(raw)
  return Number.isInteger(value) && value >= 50 ? value : DEFAULT_HEARTBEAT_MS
}

/**
 * The parts of a socket the stall rule reads. `net.Socket` has all of them.
 *
 * Node's `bytesWritten` counts bytes still queued in the socket's own buffer as written, so a queued heartbeat
 * would look like progress. The bytes that actually left are `bytesWritten - writableLength`, and that is what the
 * rule measures (found by the verifier: a paused peer kept growing `bytesWritten` by one heartbeat per interval).
 */
export interface WatchedSocket {
  readonly writableLength: number
  readonly bytesWritten: number
  readonly destroyed: boolean
  destroy(): void
}

/**
 * Finds the connections that stopped taking bytes.
 *
 * `sweep` is called once per heartbeat. A socket shows **activity** when it has nothing waiting to be sent, or
 * when the bytes that left it (`bytesWritten - writableLength`) moved since the last sweep. One that has shown no activity for `2 × interval` is
 * destroyed, which ends its stream and frees what was queued for it.
 */
export class StallWatch {
  private readonly seen = new WeakMap<WatchedSocket, { bytes: number; activeAt: number }>()
  private readonly intervalMs: number

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs
  }

  /** The time after which a socket with no activity is dead: two intervals. */
  get deadlineMs(): number {
    return this.intervalMs * 2
  }

  /** Judge every socket once; returns the ones it destroyed. */
  sweep(sockets: Iterable<WatchedSocket>, now: number): WatchedSocket[] {
    const ended: WatchedSocket[] = []
    for (const socket of sockets) {
      if (socket.destroyed) continue
      const last = this.seen.get(socket)
      const bytes = socket.bytesWritten - socket.writableLength
      if (last === undefined || socket.writableLength === 0 || bytes !== last.bytes) {
        this.seen.set(socket, { bytes, activeAt: now })
        continue
      }
      if (now - last.activeAt >= this.deadlineMs) {
        socket.destroy()
        ended.push(socket)
      }
    }
    return ended
  }
}
