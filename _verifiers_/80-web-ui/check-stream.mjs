import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * 80-web-ui — the live event stream, judged against DSH's `$events` stream (DSH parity phase B, developer-ten).
 *
 * The rows come from `_designs_/dsh-parity/results-developer-ten.md` (S15, S16, S19-S24) and the shape from the
 * DSH Gateway and API Remotes: the stream opens with `{ type: 'ready', clientId, host: { home } }` after its
 * incremental listeners are attached, so a baseline read started on `ready` cannot race an increment.
 *
 * Every check stands up its own server with an isolated home and a scripted endpoint, on a port the OS chooses,
 * and reads the stream as raw SSE, because the frames themselves are the claim.
 */

const CAPABILITY = 'a live event stream with the opening frame and recovery DSH gives its $events stream'

const servers = new Set()
after(() => Promise.all([...servers].map((server) => server.close())))

/** Spawn `heddle web` on a free port with a scripted endpoint; resolves once it prints its URL. */
function startServer(label, steps = [{ text: 'scripted answer' }], extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const home = isolatedHome(`stream-${label}`)
      const work = fixtureDir(`stream-${label}-work`)
      const { config, script } = scriptedConfig({ home, steps })
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          const server = {
            url: match[1],
            port: Number(match[2]),
            home,
            work,
            script,
            output: () => output,
            close: async () => {
              servers.delete(server)
              child.kill('SIGKILL')
              removeDir(home)
              removeDir(work)
            },
          }
          servers.add(server)
          resolvePromise(server)
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 15s\n${output}`))
        }
      }, 15_000).unref()
    })()
  })
}

/** The cookie the launch URL mints, as `name=value`. */
async function cookieFor(server) {
  const response = await fetch(server.url, { redirect: 'manual' })
  const set = response.headers.get('set-cookie')
  if (set === null) throw new Error(`no cookie from the launch URL (HTTP ${response.status})`)
  return set.split(';')[0]
}

/** A JSON API call with the cookie. */
async function api(server, cookie, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: response.status, text, json }
}

/**
 * Open `GET /api/events` with the cookie and parse frames as they arrive.
 * `frames` holds `{ event, data, id, comment }`; `next(predicate, ms)` resolves with the first frame that matches.
 */
async function openStream(server, cookie, headers = {}) {
  const http = await import('node:http')
  const stream = { frames: [], chunks: [], closed: false, status: null }
  const waiters = []
  let buffer = ''
  const settle = () => {
    for (const waiter of [...waiters]) {
      const found = stream.frames.find(waiter.predicate)
      if (found !== undefined) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(found)
      }
    }
  }
  const request = http.get({ host: '127.0.0.1', port: server.port, path: '/api/events', headers: { cookie, accept: 'text/event-stream', ...headers } }, (response) => {
    stream.status = response.statusCode
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      stream.chunks.push({ at: Date.now(), chunk })
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const frame = { event: null, data: null, id: null, comment: null, at: Date.now() }
        const data = []
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) frame.comment = line.slice(1).trim()
          else if (line.startsWith('event:')) frame.event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          else if (line.startsWith('id:')) frame.id = line.slice(3).trim()
        }
        if (data.length > 0) {
          frame.event ??= 'message'
          try {
            frame.data = JSON.parse(data.join('\n'))
          } catch {
            frame.data = data.join('\n')
          }
        }
        stream.frames.push(frame)
      }
      settle()
    })
    response.on('end', () => (stream.closed = true))
  })
  request.on('error', () => (stream.closed = true))
  stream.close = () => {
    stream.closed = true
    request.destroy()
  }
  stream.next = (predicate, ms = 10_000) =>
    new Promise((resolvePromise, reject) => {
      const found = stream.frames.find(predicate)
      if (found !== undefined) return resolvePromise(found)
      const waiter = { predicate, resolve: resolvePromise }
      waiters.push(waiter)
      setTimeout(() => {
        const at = waiters.indexOf(waiter)
        if (at >= 0) {
          waiters.splice(at, 1)
          reject(new Error(`no matching frame within ${ms} ms; frames so far: ${JSON.stringify(stream.frames.map((frame) => frame.event ?? `:${frame.comment}`))}`))
        }
      }, ms).unref()
    })
  return stream
}

/** Run one turn to its end through `POST /api/turn`. */
async function runTurn(server, cookie, body) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/turn`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

/** The number of entries in a session's log, read through the log route. */
async function logEntries(server, cookie, session) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${encodeURIComponent(session)}/log`, { headers: { cookie } })
  return (await response.text()).split('\n').filter((line) => line.trim().length > 0).length
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test("the stream opens with DSH's ready frame, and a baseline read on it misses no increment", async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('ready', [
    { text: 'round one ', toolCall: { name: 'bash', arguments: { command: 'true' } } },
    { text: 'round two ', toolCall: { name: 'bash', arguments: { command: 'true' } } },
    { text: 'done' },
  ])
  try {
    const cookie = await cookieFor(server)
    const stream = await openStream(server, cookie)
    const ready = await stream.next((frame) => frame.event !== null, 10_000)

    /** The first event is `ready`, carrying DSH's opening item: `{ type: 'ready', clientId, host: { home } }`. */
    assert.equal(ready.event, 'ready', `the first event on the stream is ready (got ${ready.event})`)
    assert.equal(ready.data?.type, 'ready', 'and its data says so')
    assert.match(String(ready.data?.clientId), /^[0-9a-f]{32}$/, 'it names this stream with a client id')
    assert.equal(typeof ready.data?.host?.home, 'string', "and carries the Host's home")
    assert.equal(ready.data.host.home, server.home, "the Host's home is the server's own home folder")

    /** A second stream is a second client. */
    const other = await openStream(server, cookie)
    const otherReady = await other.next((frame) => frame.event === 'ready', 10_000)
    assert.notEqual(otherReady.data.clientId, ready.data.clientId, 'every stream gets its own client id')
    other.close()

    /**
     * The ordering DSH guarantees: increments are attached before `ready`, so a client that reads its baseline on
     * `ready` sees every later change. A turn started after the baseline read is carried in full: the log grows by
     * exactly the number of session frames the stream delivers for that session.
     */
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    const created = await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'baseline' })
    assert.equal(created.status, 200, created.text)
    const session = created.json.session
    const baseline = await logEntries(server, cookie, session)
    const startedAt = Date.now()
    const turn = await runTurn(server, cookie, { session, prompt: 'go' })
    assert.equal(turn.status, 200, turn.text)
    await stream.next((frame) => frame.event === 'session' && frame.data?.session === session && frame.data?.event?.type === 'turn/completed', 10_000)
    const appended = (await logEntries(server, cookie, session)) - baseline
    const carried = stream.frames.filter((frame) => frame.event === 'session' && frame.data?.session === session && frame.at >= startedAt).length
    assert.ok(appended > 3, `the turn wrote to the log (${appended} entries)`)
    assert.equal(carried, appended, `every entry the turn wrote reached the stream (${carried} of ${appended})`)
    stream.close()
  } finally {
    await server.close()
  }
})

/**
 * A subscriber that reads its response head and the opening frames, then stops reading: a peer that went away
 * without closing, as the server sees it once the socket's buffers are full. Resolves once `ready` has arrived.
 */
async function stalledSubscriber(server, cookie) {
  const net = await import('node:net')
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: server.port })
    const peer = { socket, ended: false, received: 0 }
    let text = ''
    let paused = false
    socket.on('data', (chunk) => {
      peer.received += chunk.length
      if (paused) return
      text += chunk.toString()
      if (text.includes('event: ready')) {
        paused = true
        socket.pause()
        resolvePromise(peer)
      }
    })
    socket.on('end', () => (peer.ended = true))
    socket.on('close', () => (peer.ended = true))
    socket.on('error', () => (peer.ended = true))
    socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nCookie: ${cookie}\r\nAccept: text/event-stream\r\n\r\n`)
    setTimeout(() => reject(new Error(`the stalled subscriber saw no ready frame: ${JSON.stringify(text.slice(0, 200))}`)), 10_000).unref()
  })
}

test('an idle stream carries a heartbeat every interval, and a peer that stops reading is cut after two', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  // Six megabytes of answer, written to each stream at least twice (the chunk and the completed message): more than
  // a loopback socket's send and receive buffers can absorb (4 MB each at most on macOS), so the stalled peer's
  // writes stop moving.
  const flood = 'x'.repeat(6 * 1024 * 1024)
  const server = await startServer('heartbeat', [{ text: flood }], { HEDDLE_WEB_HEARTBEAT_MS: '300' })
  try {
    const cookie = await cookieFor(server)
    const stream = await openStream(server, cookie)
    await stream.next((frame) => frame.event !== null, 10_000)

    /** DSH pings every interval so idle intermediaries see traffic; an idle heddle stream now does the same. */
    const watchedFrom = Date.now()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1600))
    const beats = stream.frames.filter((frame) => frame.event === 'heartbeat' && frame.at >= watchedFrom)
    assert.ok(beats.length >= 3, `an idle stream got ${beats.length} heartbeat frames in 1.6 s at a 300 ms interval`)
    assert.deepEqual(beats[0].data, { type: 'heartbeat' }, 'the heartbeat is {"type":"heartbeat"}')
    const gaps = beats.slice(1).map((beat, index) => beat.at - beats[index].at)
    assert.ok(Math.max(...gaps) < 900, `heartbeats arrive about once per interval (largest gap ${Math.max(...gaps)} ms)`)

    /**
     * DSH terminates a peer with no activity across two intervals. A subscriber that stops reading while a large
     * answer is written cannot take its bytes; the server must cut it, and must keep the stream that reads.
     */
    const stalled = await stalledSubscriber(server, cookie)
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    const created = await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'flood' })
    const turn = await runTurn(server, cookie, { session: created.json.session, prompt: 'a lot, please' })
    assert.equal(turn.status, 200, 'the large turn ran')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500))
    stalled.socket.resume()
    const deadline = Date.now() + 8000
    while (!stalled.ended && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    assert.equal(stalled.ended, true, `the server cut the peer that stopped reading (it had received ${stalled.received} bytes)`)
    assert.equal(stream.closed, false, 'and kept the stream that reads')
    await stream.next((frame) => frame.event === 'heartbeat' && frame.at > Date.now() - 200, 2000)
    stalled.socket.destroy()
    stream.close()
  } finally {
    await server.close()
  }
})
