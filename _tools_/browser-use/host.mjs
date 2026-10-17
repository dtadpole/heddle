import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

import { openBrowser } from './browser.mjs'
import { stateDir } from './chrome.mjs'
import { createTools } from './tools.mjs'

/**
 * The session host: a browser kept alive between command lines.
 *
 * The harness's browser is one long-lived server that holds one long-lived browser, which is what makes
 * `new_page`, then `click`, then `list_console_messages` one session rather than three unrelated
 * launches. A command-line tool needs the same thing, so this is a small detached process that owns the
 * browser and answers over a Unix socket. It is started by the first command and stopped by `stop`.
 *
 * The protocol is one JSON object per line in each direction. A command is
 * `{"id": 1, "tool": "new_page", "args": {...}}`; the answer is `{"id": 1, "ok": true, "result": {...}}`
 * or `{"id": 1, "ok": false, "error": {"message": "..."}}`. Commands are **serialized**, because two
 * browser actions that interleave are two answers about a page state neither of them describes.
 */

/** The socket and state file names, inside the state directory. */
export const SESSION_SOCKET = 'session.sock'
export const SESSION_STATE = 'session.json'

/** Where the daemon's own output goes, so a failure to start can be read afterwards. */
export function daemonLogPath(dir = stateDir()) {
  return join(dir, 'daemon.log')
}

/** Read one newline-delimited JSON message from a socket, resolving at the first complete line. */
function readLine(socket) {
  return new Promise((resolvePromise, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      cleanup()
      const line = buffer.slice(0, index)
      try {
        resolvePromise(JSON.parse(line))
      } catch (error) {
        reject(new Error(`the session host answered with something that is not JSON: ${String(error)}`))
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('the session host closed the connection without answering'))
    }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** Send one request to the host and read its answer. */
export async function request(socketPath, payload, timeoutMs = 120_000) {
  const socket = net.connect(socketPath)
  let timer
  try {
    await new Promise((resolvePromise, reject) => {
      socket.once('connect', resolvePromise)
      socket.once('error', reject)
    })
    const answer = readLine(socket)
    socket.write(`${JSON.stringify(payload)}\n`)
    const timeout = new Promise((_resolvePromise, reject) => {
      timer = setTimeout(() => reject(new Error(`the session host did not answer within ${timeoutMs}ms`)), timeoutMs)
    })
    return await Promise.race([answer, timeout])
  } finally {
    /**
     * The leash has to be released, not merely outrun: a pending timer is a handle on the event loop,
     * and a command line that answers in a second would otherwise sit there until the timeout expired.
     */
    if (timer !== undefined) clearTimeout(timer)
    socket.destroy()
  }
}

/**
 * Start the host and keep it until told to stop.
 *
 * Returns the handles the caller (`cli.mjs __daemon`) needs, rather than listening for signals itself,
 * so that an embedding caller can decide how the process ends.
 */
export async function startHost(options = {}) {
  const dir = options.stateDir ?? stateDir()
  mkdirSync(dir, { recursive: true })
  const socketPath = join(dir, SESSION_SOCKET)
  const statePath = join(dir, SESSION_STATE)
  // A socket file left by a killed host would make `listen` fail with EADDRINUSE.
  rmSync(socketPath, { force: true })

  const browser = await openBrowser({
    headless: options.headless === true,
    profile: options.profile,
    binary: options.binary,
    width: options.width,
    height: options.height,
  })
  const tools = createTools(browser, { stateDir: dir })

  /** One command at a time; the next starts only when the previous answered. */
  let queue = Promise.resolve()
  const sockets = new Set()

  const answer = (socket, payload) => {
    try {
      socket.write(`${JSON.stringify(payload)}\n`)
    } catch {
      // The caller is gone; nothing to tell it.
    }
  }

  const dispatch = (socket, message) => {
    queue = queue.then(async () => {
      try {
        if (message.tool === '__ping') {
          answer(socket, {
            id: message.id,
            ok: true,
            result: {
              pid: process.pid,
              wsUrl: browser.running.wsUrl,
              headless: browser.running.headless,
              noSandbox: browser.running.noSandbox,
              pages: browser.pages.size,
              version: browser.running.version?.Browser,
            },
          })
          return
        }
        const handler = tools[message.tool]
        if (handler === undefined) {
          answer(socket, { id: message.id, ok: false, error: { message: `there is no browser tool called '${String(message.tool)}'` } })
          return
        }
        const result = await handler(message.args ?? {})
        answer(socket, { id: message.id, ok: true, result })
      } catch (error) {
        answer(socket, {
          id: message.id,
          ok: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      }
    })
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length === 0) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          answer(socket, { id: null, ok: false, error: { message: 'the request was not JSON' } })
          continue
        }
        if (message.tool === '__shutdown') {
          answer(socket, { id: message.id, ok: true, result: { stopping: true } })
          void shutdown()
          return
        }
        dispatch(socket, message)
      }
    })
  })

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolvePromise)
  })

  writeFileSync(
    statePath,
    JSON.stringify(
      {
        pid: process.pid,
        socket: socketPath,
        stateDir: dir,
        startedAt: new Date().toISOString(),
        headless: browser.running.headless,
        noSandbox: browser.running.noSandbox,
        wsUrl: browser.running.wsUrl,
        port: browser.running.port,
        version: browser.running.version?.Browser,
      },
      null,
      2,
    ),
  )

  let stopping
  const shutdown = async () => {
    if (stopping !== undefined) return stopping
    stopping = (async () => {
      server.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await browser.close().catch(() => {})
      rmSync(socketPath, { force: true })
      rmSync(statePath, { force: true })
    })()
    return stopping
  }

  /** A browser that dies takes the host with it, so the next command starts a fresh one. */
  void browser.connection.whenClosed().then(() => {
    if (stopping === undefined) void shutdown().then(() => process.exit(0))
  })

  return { browser, server, socketPath, statePath, shutdown }
}
