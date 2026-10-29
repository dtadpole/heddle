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
function startServer(label, steps = [{ text: 'scripted answer' }]) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const home = isolatedHome(`stream-${label}`)
      const work = fixtureDir(`stream-${label}-work`)
      const { config, script } = scriptedConfig({ home, steps })
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
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
    /**
     * Counted by the log's own sequence numbers, not by arrival time: under load, or after the 80 checks that run
     * before this one, frames and log lines land at their own pace (integrator-two saw an arrival-time count fail in
     * full lanes). Every session frame carries its event's `seq`, the entry's index in the log, so "every entry the
     * turn wrote reached the stream" is: the stream holds each seq from the baseline up to the log's end.
     */
    const baseline = await logEntries(server, cookie, session)
    const turn = await runTurn(server, cookie, { session, prompt: 'go' })
    assert.equal(turn.status, 200, turn.text)
    await stream.next((frame) => frame.event === 'session' && frame.data?.session === session && frame.data?.event?.type === 'turn/completed', 30_000)
    const carriedSeqs = () =>
      new Set(
        stream.frames
          .filter((frame) => frame.event === 'session' && frame.data?.session === session && Number.isInteger(frame.data?.event?.seq) && frame.data.event.seq >= baseline)
          .map((frame) => frame.data.event.seq),
      )
    // The log may still be a line behind the stream, or the stream behind the log, for a moment: both settle.
    let logged = await logEntries(server, cookie, session)
    const settleBy = Date.now() + 10_000
    while (carriedSeqs().size !== logged - baseline && Date.now() < settleBy) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      logged = await logEntries(server, cookie, session)
    }
    const appended = logged - baseline
    const carried = carriedSeqs()
    assert.ok(appended > 3, `the turn wrote to the log (${appended} entries)`)
    assert.equal(carried.size, appended, `every entry the turn wrote reached the stream (${carried.size} of ${appended})`)
    for (let seq = baseline; seq < logged; seq += 1) assert.ok(carried.has(seq), `log entry ${seq} reached the stream`)
    stream.close()
  } finally {
    await server.close()
  }
})
