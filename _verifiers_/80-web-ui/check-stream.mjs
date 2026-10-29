import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'
import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'

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
  const home = isolatedHome(`stream-${label}`)
  const work = fixtureDir(`stream-${label}-work`)
  const { config, script } = scriptedConfig({ home, steps })
  return spawnHeddle({ home, work, config, script, port: 0, extraEnv })
}

/** Start the same server again — same home, secret, store and port — after it was stopped. */
function restartServer(server) {
  return spawnHeddle({ home: server.home, work: server.work, config: server.config, script: server.script, port: server.port, extraEnv: server.extraEnv })
}

function spawnHeddle({ home, work, config, script, port, extraEnv }) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const env = { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config, ...extraEnv }
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', String(port), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work]),
        { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
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
            config,
            script,
            extraEnv,
            env,
            output: () => output,
            /** Stop the process and keep its home, so it can be started again. */
            stop: () =>
              new Promise((done) => {
                servers.delete(server)
                if (child.exitCode !== null) return done()
                child.once('exit', () => done())
                child.kill('SIGKILL')
              }),
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
async function openStream(server, cookie, headers = {}, path = '/api/events') {
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
  const request = http.get({ host: '127.0.0.1', port: server.port, path, headers: { cookie, accept: 'text/event-stream', ...headers } }, (response) => {
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
    // The creation's own frame is waited for first, so it cannot arrive after the clock starts and be counted
    // against the turn (a race the Rust server's asynchronous body write exposed).
    await stream.next((frame) => frame.event === 'session' && frame.data?.session === session && frame.data?.event?.type === 'session/created', 10_000)
    const baseline = await logEntries(server, cookie, session)
    const startedAt = Date.now()
    const turn = await runTurn(server, cookie, { session, prompt: 'go' })
    assert.equal(turn.status, 200, turn.text)
    await stream.next((frame) => frame.event === 'session' && frame.data?.session === session && frame.data?.event?.type === 'turn/completed', 10_000)
    const carried = stream.frames.filter((frame) => frame.event === 'session' && frame.data?.session === session && frame.at >= startedAt).length
    // The claim is completeness, not write-before-push order: the log is read until it stops growing (up to 2 s),
    // because the Rust server may push a frame a moment before its line is on disk.
    let appended = (await logEntries(server, cookie, session)) - baseline
    for (let tries = 0; tries < 40 && appended < carried; tries += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      appended = (await logEntries(server, cookie, session)) - baseline
    }
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

/** The sequence number of a frame id `<epoch>-<seq>`. */
const seqOf = (id) => Number(String(id).slice(String(id).lastIndexOf('-') + 1))

test('a reconnecting client is given every frame it missed after its cursor, and a cursor from another start gets reset', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('follow', [
    { text: 'one ', toolCall: { name: 'bash', arguments: { command: 'true' } } },
    { text: 'two' },
  ])
  try {
    const cookie = await cookieFor(server)
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    const created = await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'follow' })
    const session = created.json.session

    /** Every frame on the followed stream carries an id, `<epoch>-<seq>`, counting up by one. */
    const first = await openStream(server, cookie)
    const ready = await first.next((frame) => frame.event === 'ready')
    assert.equal(typeof ready.data.cursor, 'string', 'ready names the newest id')
    assert.equal(ready.data.resumed, false, 'a first connection resumes nothing')
    assert.ok(Number.isInteger(ready.data.heartbeatMs) && ready.data.heartbeatMs > 0, 'and says the heartbeat interval')
    await runTurn(server, cookie, { session, prompt: 'first' })
    await first.next((frame) => frame.event === 'session' && frame.data?.event?.type === 'turn/completed')
    const numbered = first.frames.filter((frame) => frame.event === 'session')
    assert.ok(numbered.every((frame) => /^[0-9a-f]+-\d+$/.test(frame.id ?? '')), 'every session frame has an id')
    const seqs = numbered.map((frame) => seqOf(frame.id))
    assert.deepEqual(seqs, seqs.map((_, index) => seqs[0] + index), 'ids count up by one with no gap')
    const lastSeen = numbered.at(-1).id
    first.close()

    /** A turn runs while no stream is open; the reconnect is given all of it, after ready, and nothing twice. */
    const before = await logEntries(server, cookie, session)
    await runTurn(server, cookie, { session, prompt: 'while away' })
    const missed = (await logEntries(server, cookie, session)) - before
    for (const [how, reconnect] of [
      ['Last-Event-ID', () => openStream(server, cookie, { 'last-event-id': lastSeen })],
      ['?cursor=', () => openStream(server, cookie, {}, `/api/events?cursor=${encodeURIComponent(lastSeen)}`)],
    ]) {
      const again = await reconnect()
      const resumed = await again.next((frame) => frame.event === 'ready')
      assert.equal(resumed.data.resumed, true, `${how}: the cursor was honoured`)
      await again.next((frame) => frame.event === 'session' && frame.data?.event?.type === 'turn/completed')
      const replayed = again.frames.filter((frame) => frame.event === 'session')
      assert.equal(replayed.length, missed, `${how}: every entry written while away was replayed (${replayed.length} of ${missed})`)
      assert.equal(seqOf(replayed[0].id), seqOf(lastSeen) + 1, `${how}: starting right after the cursor`)
      assert.ok(again.frames.indexOf(resumed) < again.frames.indexOf(replayed[0]), `${how}: after ready`)
      again.close()
    }

    /** A cursor this server never gave (another start) cannot be resumed: ready says so and reset follows. */
    const stranger = await openStream(server, cookie, { 'last-event-id': '0000000000000000-12' })
    const notResumed = await stranger.next((frame) => frame.event === 'ready')
    assert.equal(notResumed.data.resumed, false, 'a cursor from another start is not honoured')
    const reset = await stranger.next((frame) => frame.event !== null && frame.event !== 'ready' && frame.event !== 'heartbeat')
    assert.equal(reset.event, 'reset', 'and the client is told to re-read its baselines')
    stranger.close()
  } finally {
    await server.close()
  }
})

test('the page shows it is reconnecting while the server is down, and a session made meanwhile appears without a reload', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  let server = await startServer('page-reconnect', [{ text: 'scripted answer' }], { HEDDLE_WEB_HEARTBEAT_MS: '500' })
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const cookie = await cookieFor(server)
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'before the outage' })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    assert.ok(await browser.waitFor('document.body.dataset.connection === "open"', 10_000), 'the page says its stream is open')
    assert.equal(await browser.evaluate('document.getElementById("connection-state").hidden'), true, 'and shows no connection notice')

    /** DSH shows a connecting state while it retries; so must the page, within a few seconds of losing the server. */
    await server.stop()
    assert.ok(await browser.waitFor('document.body.dataset.connection === "connecting"', 8000), 'the page knows the stream is down')
    assert.equal(await browser.evaluate('document.getElementById("connection-state").hidden'), false, 'and shows it')

    /** A session made while the page cannot hear about it: the CLI writes the same store. */
    // From the checkout, as the server runs: the TypeScript CLI composes its layers from its working folder.
    const made = await runCli(['session', 'new', server.work, '--session-root', join(server.home, 'sessions')], { env: server.env })
    assert.equal(made.code, 0, `the CLI made a session while the server was down: ${made.stderr}`)

    server = await restartServer(server)
    const sessions = await api(server, cookie, 'GET', '/api/sessions')
    const fresh = sessions.json.find((entry) => entry.title !== 'before the outage')
    assert.ok(fresh !== undefined, 'the restarted server lists the session made while it was down')
    assert.ok(await browser.waitFor('document.body.dataset.connection === "open"', 20_000), 'the page reconnects on its own')
    assert.equal(await browser.evaluate('document.getElementById("connection-state").hidden'), true, 'and the notice goes')
    assert.ok(
      await browser.waitFor(`document.querySelector('#tree li[data-session-id="${fresh.id}"]') !== null`, 10_000),
      'the session made while it was away appears in the tree without a reload',
    )
  } finally {
    browser.close()
    await server.close()
  }
})

/** A turn whose first call is denied under workspace-write and whose retry asks to widen: an approval question. */
const escalationSteps = (outsidePath) => [
  { toolCall: { name: 'bash', arguments: { command: `echo outside > ${JSON.stringify(outsidePath)}` } } },
  {
    toolCall: {
      name: 'bash',
      arguments: {
        command: `echo outside > ${JSON.stringify(outsidePath)}`,
        sandbox_permissions: 'danger-full-access',
        justification: 'the write target is outside the workspace and the task requires it',
      },
    },
  },
  { text: 'done' },
]

test('renames, workspace edits and settled approvals are pushed to every stream, numbered like every frame', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const outsideDir = fixtureDir('stream-push-outside')
  const extra = fixtureDir('stream-push-extra')
  const server = await startServer('push', escalationSteps(join(outsideDir, 'outside.txt')))
  try {
    const cookie = await cookieFor(server)
    const pages = [await openStream(server, cookie), await openStream(server, cookie)]
    for (const page of pages) await page.next((frame) => frame.event === 'ready')
    /** Every page hears the change, as a frame with an id (so a page that was away is given it on reconnect). */
    const heard = async (event, match, label) => {
      const frames = await Promise.all(pages.map((page) => page.next((frame) => frame.event === event && match(frame.data), 10_000)))
      for (const frame of frames) assert.match(frame.id ?? '', /^[0-9a-f]+-\d+$/, `${label}: numbered`)
      return frames[0]
    }

    /** DSH pushes workspace increments: an added, renamed and removed root reach every page. */
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    const added = await api(server, cookie, 'POST', '/api/workspaces', { path: extra })
    assert.equal(added.status, 200, added.text)
    const addedFrame = await heard('workspace', (data) => data?.type === 'workspace/added' && String(data.workspace?.path ?? '').includes('stream-push-extra'), 'an added workspace')
    const workspaceId = addedFrame.data.workspace.id
    const renamed = await api(server, cookie, 'PATCH', `/api/workspaces/${encodeURIComponent(workspaceId)}`, { title: 'pushed-root' })
    assert.equal(renamed.status, 200, renamed.text)
    await heard('workspace', (data) => data?.type === 'workspace/renamed' && data.workspace?.id === workspaceId, 'a renamed workspace')

    /** DSH pushes api-session changes: a renamed session reaches every page with its new title. */
    const created = await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'before' })
    const session = created.json.session
    const titled = await api(server, cookie, 'POST', `/api/sessions/${encodeURIComponent(session)}/title`, { title: 'pushed title' })
    assert.equal(titled.status, 200, titled.text)
    await heard('sessions', (data) => data?.type === 'session/renamed' && data.session === session && data.title === 'pushed title', 'a renamed session')

    const removed = await api(server, cookie, 'DELETE', `/api/workspaces/${encodeURIComponent(workspaceId)}`)
    assert.equal(removed.status, 200, removed.text)
    await heard('workspace', (data) => data?.type === 'workspace/removed' && data.id === workspaceId, 'a removed workspace')

    /** An approval answered anywhere is announced as settled to every page, with its outcome. */
    const turn = runTurn(server, cookie, { session, prompt: 'write outside' })
    const asked = await pages[0].next((frame) => frame.event === 'approval', 20_000)
    const answered = await api(server, cookie, 'POST', `/api/approvals/${encodeURIComponent(asked.data.id)}`, { outcome: 'rejected' })
    assert.equal(answered.status, 200, answered.text)
    await heard('approval-settled', (data) => data?.type === 'approval/settled' && data.id === asked.data.id && data.outcome === 'rejected', 'a settled approval')
    assert.equal((await turn).status, 200, 'the turn ended once its question was answered')
    for (const page of pages) page.close()
  } finally {
    removeDir(outsideDir)
    removeDir(extra)
    await server.close()
  }
})

test('a page redraws a rename and a new workspace made elsewhere, without a reload', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const extra = fixtureDir('stream-page-push-extra')
  const server = await startServer('page-push')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const cookie = await cookieFor(server)
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    const created = await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'old title' })
    const session = created.json.session
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    assert.ok(await browser.waitFor(`document.querySelector('#tree li[data-session-id="${session}"]') !== null`, 10_000), 'the session is in the tree')
    await browser.evaluate('window.__heddleNoReload = true')

    /** Another page renames the session: this one redraws the row, with no reload in between. */
    await api(server, cookie, 'POST', `/api/sessions/${encodeURIComponent(session)}/title`, { title: 'renamed elsewhere' })
    assert.ok(
      await browser.waitFor(`(document.querySelector('#tree li[data-session-id="${session}"]')?.textContent ?? '').includes('renamed elsewhere')`, 8000),
      'the renamed session shows its new title',
    )

    /** Another page adds a workspace: it appears in this tree too. */
    await api(server, cookie, 'POST', '/api/workspaces', { path: extra })
    assert.ok(
      await browser.waitFor(`document.getElementById('tree').textContent.includes('stream-page-push-extra')`, 8000),
      'the added workspace appears in the tree',
    )
    assert.equal(await browser.evaluate('window.__heddleNoReload === true'), true, 'and the page was never reloaded')
  } finally {
    browser.close()
    removeDir(extra)
    await server.close()
  }
})

test('an approval answered on one page closes on every page', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const outsideDir = fixtureDir('stream-approve-outside')
  const server = await startServer('approve', escalationSteps(join(outsideDir, 'outside.txt')))
  const pages = [await openBrowser({ width: 1280, height: 900 }), await openBrowser({ width: 1280, height: 900 })]
  try {
    const cookie = await cookieFor(server)
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    const created = await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'two pages' })
    const session = created.json.session
    for (const page of pages) {
      await page.goto(server.url)
      await page.waitFor('document.body.dataset.ready === "true"', 25_000)
      await page.waitFor(`document.querySelector('#tree li[data-session-id="${session}"]') !== null`, 10_000)
      await page.evaluate(`(document.querySelector('li[data-session-id="${session}"] .row') || document.querySelector('li[data-session-id="${session}"]')).click()`)
      assert.ok(await page.waitFor(`document.getElementById('session-title').textContent.includes('two pages')`, 10_000), 'each page has the session open')
    }

    /** One question, shown on both pages. */
    const turn = runTurn(server, cookie, { session, prompt: 'write outside' })
    for (const page of pages) {
      assert.ok(await page.waitFor('document.getElementById("approval-card").hidden === false', 20_000), 'both pages show the question')
    }

    /** DSH ends the waterfall for every client once one answers: the other page's card goes without being pressed. */
    await pages[0].evaluate('document.getElementById("approval-reject").click()')
    assert.ok(await pages[0].waitFor('document.getElementById("approval-card").hidden === true', 10_000), 'the answering page closes its card')
    assert.ok(await pages[1].waitFor('document.getElementById("approval-card").hidden === true', 5000), 'and the other page closes the same card on its own')
    assert.equal(await pages[1].evaluate('document.getElementById("approval-note").hidden'), true, 'with no refusal note: nobody pressed a stale card')
    assert.equal((await turn).status, 200, 'the turn ended once its question was answered')
  } finally {
    for (const page of pages) page.close()
    removeDir(outsideDir)
    await server.close()
  }
})

test('a failed turn reaches every client and the log, not only the client that started it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  // R-developer-six-2 (S83): the endpoint's step fails as a 502 does.
  const server = await startServer('failed', [{ error: { status: 502, message: 'upstream answered 502' } }])
  try {
    const cookie = await cookieFor(server)
    await api(server, cookie, 'POST', '/api/workspaces', { path: server.work })
    const created = await api(server, cookie, 'POST', '/api/sessions', { branch: server.work, title: 'fails' })
    const session = created.json.session
    const watcher = await openStream(server, cookie)
    await watcher.next((frame) => frame.event === 'ready')

    /** The client that started the turn is told, as before. */
    const turn = await runTurn(server, cookie, { session, prompt: 'fail, please' })
    assert.equal(turn.status, 200)
    assert.match(turn.text, /event: error\n/, 'the starting client gets the error on its own response')

    /** DSH's api-session/error: every other client hears it too, and for them the turn has ended. */
    const failed = await watcher.next((frame) => frame.event === 'session' && frame.data?.session === session && frame.data?.event?.type === 'turn/failed', 10_000)
    assert.match(String(failed.data.event.message), /502/, 'another client gets the failure with its message')

    /** It is in the log, so a reload can tell the turn failed, and the transcript says so. */
    const log = await (await fetch(`http://127.0.0.1:${server.port}/api/sessions/${encodeURIComponent(session)}/log`, { headers: { cookie } })).text()
    assert.ok(log.split('\n').some((line) => line.includes('"type":"turn/failed"')), 'the log records the failed turn')
    const read = await api(server, cookie, 'GET', `/api/sessions/${encodeURIComponent(session)}`)
    const ended = (read.json?.turns ?? []).flatMap((entry) => entry.ended ?? [])
    assert.ok(ended.some((reason) => /the turn failed: .*502/.test(reason)), `the transcript carries it as the stop reason (${JSON.stringify(ended)})`)
    watcher.close()
  } finally {
    await server.close()
  }
})
