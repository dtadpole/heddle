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

/**
 * The opening frame's data, keys in DSH's order, then heddle's follow fields.
 *
 * DSH's item is `{ type, clientId, host: { home } }`. heddle adds what its reconnect needs, after those keys:
 * `cursor`, the id of the newest frame this stream has been given (the page resumes from it); `resumed`, whether
 * the cursor the client presented was honoured (frames after it follow `ready`); and `heartbeatMs`, so the page
 * knows how long silence means a dead stream.
 */
export interface ReadyFrame {
  readonly type: 'ready'
  readonly clientId: string
  readonly host: { readonly home: string }
  readonly cursor?: string
  readonly resumed?: boolean
  readonly heartbeatMs?: number
}

/** The follow fields a server adds to `ready`. */
export interface ReadyFollow {
  readonly cursor: string
  readonly resumed: boolean
  readonly heartbeatMs: number
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
export function readyData(clientId: string, home: string = homedir(), follow?: ReadyFollow): ReadyFrame {
  return follow === undefined
    ? { type: 'ready', clientId, host: { home } }
    : { type: 'ready', clientId, host: { home }, cursor: follow.cursor, resumed: follow.resumed, heartbeatMs: follow.heartbeatMs }
}

/** The opening frame as it goes on the wire: `event: ready` and one line of JSON. */
export function readyFrame(clientId: string, home: string = homedir(), follow?: ReadyFollow): string {
  return `event: ${READY_EVENT}\ndata: ${JSON.stringify(readyData(clientId, home, follow))}\n\n`
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

/**
 * The follow cursor: every frame a stream is given carries an id, and a reconnecting client is given what it
 * missed.
 *
 * DSH resumes a session journal from a cursor (`session/follow`, `RemoteJournalStream`'s reconnect catch-up) and,
 * where nothing can be resumed, tells its owners to re-read their baselines (`connection/reset`). heddle has one
 * stream for everything, so it does both on that stream:
 *
 * - every published frame gets the id `<epoch>-<seq>`, where `epoch` is random per server start and `seq` counts
 *   up from 1, and the newest frames are kept in a bounded log;
 * - a client that reconnects with `Last-Event-ID` (the browser sends it on its own retries) or `?cursor=` (the page
 *   sends it when it reconnects itself) is given every kept frame after that id, right after `ready`;
 * - a cursor that cannot be honoured — another epoch (the server restarted), older than the log, malformed, or
 *   ahead of it — gets a `reset` frame instead, and the client re-reads its baselines.
 *
 * Heartbeats and `ready` carry no id: they are about the connection, not the record, and an SSE frame without an id
 * leaves the browser's last event id where it was.
 */

/** The event name of the frame that tells a client to re-read its baselines. */
export const RESET_EVENT = 'reset'

/** The reset frame as it goes on the wire. */
export function resetFrame(): string {
  return `event: ${RESET_EVENT}\ndata: {"type":"reset"}\n\n`
}

/** One kept frame: its sequence number, its wire text (id line included) and its size. */
interface Kept {
  readonly seq: number
  readonly text: string
}

/** A bounded log of the frames published on the stream, each with its id. */
export class EventLog {
  readonly epoch: string
  private seq = 0
  private readonly kept: Kept[] = []
  private keptBytes = 0
  private readonly maxFrames: number
  private readonly maxBytes: number

  constructor(options: { readonly epoch?: string; readonly maxFrames?: number; readonly maxBytes?: number } = {}) {
    this.epoch = options.epoch ?? randomBytes(8).toString('hex')
    this.maxFrames = options.maxFrames ?? 4096
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  }

  /** The id of the newest frame, or `<epoch>-0` before the first. */
  get cursor(): string {
    return `${this.epoch}-${this.seq}`
  }

  /** Give the next id to a frame, keep it, and return its wire text with the id line first. */
  record(event: string, data: string): string {
    this.seq += 1
    const text = `id: ${this.epoch}-${this.seq}\nevent: ${event}\ndata: ${data}\n\n`
    this.kept.push({ seq: this.seq, text })
    this.keptBytes += text.length
    while (this.kept.length > this.maxFrames || (this.keptBytes > this.maxBytes && this.kept.length > 1)) {
      this.keptBytes -= this.kept.shift()!.text.length
    }
    return text
  }

  /**
   * The wire text of every kept frame after `cursor`, oldest first, or `null` when the cursor cannot be honoured:
   * another epoch, a sequence number the log no longer reaches back to, one it has not reached, or a malformed id.
   */
  since(cursor: string): string[] | null {
    const dash = cursor.lastIndexOf('-')
    if (dash <= 0) return null
    const epoch = cursor.slice(0, dash)
    const seqText = cursor.slice(dash + 1)
    if (epoch !== this.epoch || !/^\d+$/.test(seqText)) return null
    const seq = Number(seqText)
    if (seq > this.seq) return null
    const oldest = this.kept[0]?.seq ?? this.seq + 1
    if (seq < oldest - 1) return null
    return this.kept.filter((frame) => frame.seq > seq).map((frame) => frame.text)
  }
}

/**
 * The replay without questions that no longer wait.
 *
 * DSH replays a pending approval or question after a reconnect, never one that was settled meanwhile; replaying an
 * answered `approval` frame would put a stale card back on the page until something closed it again. A replayed
 * `approval` frame is kept only while its question is in `waiting` (the approval service's pending ids). Every other
 * frame, `approval-settled` included, is kept as it is.
 */
export function withoutSettledApprovals(frames: readonly string[], waiting: ReadonlySet<string>): string[] {
  return frames.filter((text) => {
    if (!/^event: approval$/m.test(text)) return true
    const data = /^data: (.*)$/m.exec(text)?.[1] ?? ''
    try {
      const id = (JSON.parse(data) as { id?: unknown }).id
      return typeof id === 'string' && waiting.has(id)
    } catch {
      return false
    }
  })
}
