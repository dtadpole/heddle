import { randomBytes } from 'node:crypto'
import net from 'node:net'

/**
 * The Chrome DevTools Protocol, spoken directly: a WebSocket client on `node:net`, and the message
 * envelope around it.
 *
 * This is the layer every other file in this tool stands on, so it carries the protocol details that
 * are easy to get subtly wrong and impossible to notice from the outside:
 *
 * - **Fragmented frames.** Chrome sends a large reply — an accessibility tree, a base64 screenshot —
 *   as a first frame with FIN clear and continuation frames after it. A reader that treats every text
 *   frame as a whole message parses half a JSON document, drops it, and never answers the call. The
 *   smaller payloads a probe uses arrive whole, which is why a driver can look correct until it takes
 *   its first screenshot.
 * - **Pings.** The protocol's keepalive frames are not JSON and must be answered, or Chrome closes the
 *   socket mid-session.
 * - **Errors.** A protocol call that Chrome refuses answers `{error: {code, message}}` with the same
 *   `id` as a success. A client that only reads `result` reports `undefined` for every failure.
 * - **Masks.** A client frame must be masked; a server frame must not be. Getting that backwards is
 *   rejected by the server rather than tolerated.
 */

/** The largest frame this client accepts, so a runaway page cannot exhaust memory. */
const MAX_FRAME_BYTES = 256 * 1024 * 1024

/** How long `connect` waits for the WebSocket handshake unless the caller names a bound. */
export const CONNECT_TIMEOUT_MS = 10_000

/**
 * Encode one masked frame.
 *
 * `opcode` is `0x1` for text, `0x8` for close, `0xA` for pong. Payloads are never fragmented on the
 * way out: the messages this tool sends are small, and one frame is the whole contract.
 */
export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const mask = randomBytes(4)
  const header = [0x80 | opcode]
  if (data.length < 126) header.push(0x80 | data.length)
  else if (data.length < 65_536) header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff)
  else {
    header.push(0x80 | 127, 0, 0, 0, 0, (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff)
  }
  const masked = Buffer.alloc(data.length)
  for (let index = 0; index < data.length; index += 1) masked[index] = data[index] ^ mask[index % 4]
  return Buffer.concat([Buffer.from(header), mask, masked])
}

/**
 * Decode one frame, or `null` when the buffer does not yet hold a whole one.
 *
 * Returns the frame's `opcode`, `payload`, `fin` flag and how many bytes it consumed.
 */
export function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const short = buffer[1] & 0x7f
  let offset = 2
  let length = short
  if (short === 126) {
    if (buffer.length < 4) return null
    length = (buffer[2] << 8) | buffer[3]
    offset = 4
  } else if (short === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (length > MAX_FRAME_BYTES) throw new Error(`a websocket frame of ${length} bytes is beyond this client's limit`)
  const masked = (buffer[1] & 0x80) !== 0
  let mask
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  return { fin, opcode, payload, consumed: offset + length }
}

/**
 * A connection to one DevTools WebSocket endpoint.
 *
 * The endpoint the browser prints on startup is the **browser** target. Page commands must either name
 * a session attached to that connection (`sessionId`) or go to the page's own endpoint; this client
 * supports both, and `send` takes the session as an option so one connection can carry every page.
 *
 * The handshake is **bounded** (`options.timeoutMs`, default `CONNECT_TIMEOUT_MS`), and a socket that
 * closes before it rejects too. A listening socket completes the TCP connect in the kernel whether or
 * not the browser ever reads it, so a busy or dying Chrome took the connection and never answered the
 * upgrade: the connect promise then never settled, and `stopChrome`, which connects before it signals,
 * waited forever instead of falling through to SIGTERM.
 */
export async function connect(url, options = {}) {
  const handshakeMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS
  const parsed = new URL(url)
  const key = randomBytes(16).toString('base64')
  const socket = net.connect(Number(parsed.port), parsed.hostname)
  socket.setNoDelay(true)

  let buffer = Buffer.alloc(0)
  let nextId = 1
  const pending = new Map()
  /** Standing listeners, keyed by event method and called with `(params, message)`. */
  const listeners = new Map()
  let closedReason
  const closeWaiters = []

  const failPending = (reason) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
    pending.clear()
  }

  const emit = (method, params, message) => {
    for (const listener of listeners.get(method) ?? []) {
      try {
        listener(params ?? {}, message)
      } catch {
        // A listener is the caller's code; one that throws must not take the transport down.
      }
    }
    if (method === 'Target.detachedFromTarget' || method === 'Inspector.detached') {
      // Handled by the owner, which subscribes like anyone else.
    }
  }

  const handleMessage = (message) => {
    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error !== undefined) {
        const error = new Error(message.error.message ?? 'the protocol call failed')
        error.code = message.error.code
        error.data = message.error.data
        error.method = waiter.method
        waiter.reject(error)
      } else {
        waiter.resolve(message)
      }
      return
    }
    if (typeof message.method === 'string') {
      if (process.env.HEDDLE_BROWSER_DEBUG !== undefined) console.error('[cdp] <-', message.method, message.sessionId ?? '')
      emit(message.method, message.params, message)
    }
  }

  /** Frames of one logical message, in order, until the FIN frame. */
  let fragments = null
  let fragmentOpcode = 0

  const dispatch = () => {
    for (;;) {
      const frame = decodeFrame(buffer)
      if (frame === null) return
      buffer = buffer.subarray(frame.consumed)
      if (frame.opcode === 0x0 && fragments !== null) {
        fragments.push(frame.payload)
        if (!frame.fin) continue
        const payload = Buffer.concat(fragments)
        fragments = null
        if (fragmentOpcode === 0x1) {
          try {
            handleMessage(JSON.parse(payload.toString('utf8')))
          } catch {
            // A malformed frame is dropped rather than fatal: the alternative is a stuck call.
          }
        }
        continue
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (!frame.fin) {
          fragments = [frame.payload]
          fragmentOpcode = frame.opcode
          continue
        }
        if (frame.opcode === 0x1) {
          let message
          try {
            message = JSON.parse(frame.payload.toString('utf8'))
          } catch {
            continue
          }
          handleMessage(message)
        }
        continue
      }
      if (frame.opcode === 0x8) {
        if (process.env.HEDDLE_BROWSER_DEBUG !== undefined) {
          console.error('[cdp] close frame', frame.payload.toString('utf8'), 'code', frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : '?')
        }
        closedReason ??= new Error('the devtools websocket was closed by the browser')
        finalize()
        return
      }
      if (frame.opcode === 0x9) {
        // Ping: answer with the same payload as a pong, or the peer closes the socket.
        socket.write(encodeFrame(0xa, frame.payload))
        continue
      }
      // Pong (0xa) and anything unknown: no reply is expected.
    }
  }

  const finalize = () => {
    if (closedReason === undefined) closedReason = new Error('the devtools websocket closed')
    failPending(closedReason)
    for (const resolvePromise of closeWaiters.splice(0)) resolvePromise(closedReason)
  }

  await new Promise((resolvePromise, reject) => {
    const fail = (error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error(`the devtools endpoint at ${parsed.host} did not answer the websocket handshake within ${handshakeMs}ms`)),
      handshakeMs,
    )
    const closedEarly = () => fail(new Error(`the devtools endpoint at ${parsed.host} closed the connection before the websocket handshake`))
    socket.once('error', fail)
    socket.once('close', closedEarly)
    socket.once('connect', () => {
      socket.write(
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\n` +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      socket.off('error', fail)
      socket.off('close', closedEarly)
      const text = chunk.toString('utf8')
      if (!text.includes('101')) {
        socket.destroy()
        reject(new Error(`the devtools handshake failed: ${text.split('\r\n')[0]}`))
        return
      }
      const headerEnd = chunk.indexOf('\r\n\r\n')
      buffer = Buffer.concat([buffer, chunk.subarray(headerEnd + 4)])
      socket.on('data', (next) => {
        buffer = Buffer.concat([buffer, next])
        try {
          dispatch()
        } catch (error) {
          closedReason = error
          socket.destroy()
        }
      })
      socket.on('error', (error) => {
        if (process.env.HEDDLE_BROWSER_DEBUG !== undefined) console.error('[cdp] socket error', error.message)
      })
      socket.on('close', () => {
        finalize()
      })
      dispatch()
      resolvePromise()
    })
  })

  const connection = {
    /**
     * Send one protocol call and resolve with its full reply message.
     *
     * A reply that carries an error rejects with that error, naming the method, because a caller that
     * only sees `undefined` cannot tell a refused call from an empty one.
     */
    send(method, params = {}, { sessionId, timeoutMs = 30_000 } = {}) {
      if (closedReason !== undefined) return Promise.reject(closedReason)
      return new Promise((resolvePromise, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          const error = new Error(`the protocol call '${method}' did not answer within ${timeoutMs}ms`)
          error.method = method
          reject(error)
        }, timeoutMs)
        pending.set(id, { resolve: resolvePromise, reject, timer, method })
        socket.write(encodeFrame(0x1, JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) })))
      })
    },

    /** Subscribe to one event method. Returns a function that removes the listener. */
    on(method, handler) {
      const existing = listeners.get(method) ?? []
      existing.push(handler)
      listeners.set(method, existing)
      return () => {
        const list = listeners.get(method)
        if (list === undefined) return
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },

    /** Resolve with the next event of one method, or `null` if it does not arrive in time. */
    once(method, timeoutMs = 10_000) {
      return new Promise((resolvePromise) => {
        const remove = connection.on(method, (params) => {
          clearTimeout(timer)
          remove()
          resolvePromise(params)
        })
        const timer = setTimeout(() => {
          remove()
          resolvePromise(null)
        }, timeoutMs)
      })
    },

    /** Resolve when the connection closes, with the reason. */
    whenClosed() {
      if (closedReason !== undefined) return Promise.resolve(closedReason)
      return new Promise((resolvePromise) => closeWaiters.push(resolvePromise))
    },

    get closed() {
      return closedReason
    },

    /** Attach the connection to a target, flattened onto this same socket. */
    async attach(targetId) {
      const reply = await connection.send('Target.attachToTarget', { targetId, flatten: true })
      return reply.result.sessionId
    },

    close() {
      try {
        socket.write(encodeFrame(0x8, Buffer.alloc(0)))
      } catch {
        // The socket may already be gone; closing is still the caller's intent.
      }
      socket.destroy()
      finalize()
    },
  }

  return connection
}
