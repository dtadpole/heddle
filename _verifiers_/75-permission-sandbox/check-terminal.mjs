import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The page's interactive terminals, the server half (live-testing issue #85), judged through the HTTP API on
 * whichever build `HEDDLE_BIN` selects. No browser.
 *
 * DSH (`dsh-api-terminal-controller`) opens the session's shell in its folder and gets the screen back after a
 * reload. Closing the terminal, or disposing of the session that owns it, ends its processes. These checks are
 * developer-ten's conditions for heddle's server half:
 * - a foreign Origin or Host is refused, a request without the credential is refused, and a write must be JSON;
 * - a terminal belongs to its session: another session's path cannot reach it, and an archived session gets none;
 * - the shell is confined as bash is: under workspace-write it writes inside the session folder and is refused
 *   outside it;
 * - it is bounded (`maxTerminals`, then `409`), and closing, archiving and server shutdown each end the whole
 *   process tree.
 */

const darwin = process.platform === 'darwin'

/** Boot `heddle web` on an ephemeral port with the project's profile and an isolated home. */
function startServer(home, config) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(home, 'sessions')]),
      { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', SHELL: '/bin/sh', HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ child, url: match[1], output: () => output })
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
  })
}

/** A client holding the page's cookie, as a browser that opened the printed URL would. */
async function client(server) {
  const origin = new URL(server.url).origin
  const handshake = await fetch(server.url, { redirect: 'manual' })
  const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
  const call = async (path, init = {}) => {
    const response = await fetch(origin + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
  return { origin, cookie, call, post: (path, body) => call(path, { method: 'POST', body: JSON.stringify(body ?? {}) }) }
}

/** A raw request with headers fetch will not send as given (a foreign Host). */
function raw(origin, path, headers) {
  const url = new URL(path, origin)
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers }, (response) => {
      response.resume()
      response.on('end', () => resolvePromise(response.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Read a terminal's event stream until `pattern` appears in its output, then stop reading. */
async function readStream(api, path, pattern, ms = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  let text = ''
  let output = ''
  let snapshot
  try {
    const response = await fetch(api.origin + path, { headers: { cookie: api.cookie }, signal: controller.signal })
    if (response.status !== 200) return { status: response.status, output, snapshot }
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true })
      let end = text.indexOf('\n\n')
      while (end >= 0) {
        const block = text.slice(0, end)
        text = text.slice(end + 2)
        const name = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (name !== undefined && data !== undefined) {
          const event = JSON.parse(data)
          if (name === 'snapshot') {
            snapshot = event
            output += event.data
          } else if (name === 'output') output += event.data
          else if (name === 'exit') return { status: 200, output, snapshot, exited: event }
        }
        end = text.indexOf('\n\n')
      }
      if (pattern !== undefined && pattern.test(output)) return { status: 200, output, snapshot }
    }
    return { status: 200, output, snapshot }
  } catch (error) {
    if (controller.signal.aborted) return { status: 200, output, snapshot, timedOut: true }
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Send a line to a terminal and wait until its output shows `pattern`. */
async function run(api, base, line, pattern) {
  const reading = readStream(api, `${base}/stream`, pattern)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const sent = await api.post(`${base}/input`, { data: `${line}\n` })
  assert.equal(sent.status, 200, `input is accepted (${JSON.stringify(sent.body)})`)
  const result = await reading
  assert.match(result.output, pattern, `the terminal printed ${pattern}`)
  return result.output
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function settle(ms = 400) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** A workspace root with two session folders, the outside folder, and a running server. */
async function fixture(label) {
  const home = isolatedHome(`terminal-${label}`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'unused' }] })
  const top = fixtureDir(`terminal-root-${label}`)
  const outside = fixtureDir(`terminal-outside-${label}`)
  const one = join(top, 'one')
  const two = join(top, 'two')
  mkdirSync(one)
  mkdirSync(two)
  const server = await startServer(home, config)
  const api = await client(server)
  const added = await api.post('/api/workspaces', { path: top })
  assert.equal(added.status, 200, `the workspace root is added (${JSON.stringify(added.body)})`)
  const sessionFor = async (folder) => {
    const opened = await api.post('/api/folders/session', { folder })
    assert.equal(opened.status, 200, `a session opens for the folder (${JSON.stringify(opened.body)})`)
    return opened.body.session.id
  }
  return {
    server,
    api,
    one,
    two,
    outside,
    a: await sessionFor(one),
    b: await sessionFor(two),
    done: () => {
      server.child.kill('SIGKILL')
      removeDir(home)
      removeDir(top)
      removeDir(outside)
    },
  }
}

test('a terminal route is fenced: foreign Origin and Host, no credential and a non-JSON write are refused', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('fence')
  try {
    const path = `/api/sessions/${f.a}/terminals`
    assert.equal((await f.api.call(path, { headers: { origin: 'http://attacker.example' } })).status, 403, 'a foreign Origin is refused')
    assert.equal(await raw(f.api.origin, path, { host: 'attacker.example', cookie: f.api.cookie }), 403, 'a foreign Host (DNS rebinding) is refused')
    assert.equal((await fetch(f.api.origin + path)).status, 401, 'a request without the credential is refused')
    const plain = await f.api.call(path, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })
    assert.equal(plain.status, 415, 'a write that is not JSON is refused')
    assert.equal((await f.api.call(path)).body.terminals.length, 0, 'and nothing was created by any of them')
    const unknown = await f.api.post('/api/sessions/session-00000000-0000-4000-8000-000000000000/terminals', {})
    assert.equal(unknown.status, 404, 'a session this server does not hold gets no terminal')
  } finally {
    f.done()
  }
})

test('a terminal runs the session’s shell in its folder, takes input and a resize, and streams the output', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('io')
  try {
    const created = await f.api.post(`/api/sessions/${f.a}/terminals`, { cols: 90, rows: 25 })
    assert.equal(created.status, 201, `a terminal is created (${JSON.stringify(created.body)})`)
    const base = `/api/sessions/${f.a}/terminals/${created.body.terminal.id}`
    const first = await run(f.api, base, 'stty size; pwd; echo "SUM-$((6*7))"', /SUM-42/)
    assert.match(first, /25 90/, 'the PTY starts at the asked size')
    assert.ok(first.includes(f.one.split('/').pop()), 'in the session folder')
    const resized = await f.api.post(`${base}/resize`, { cols: 120, rows: 40 })
    assert.equal(resized.status, 200, `a resize is accepted (${JSON.stringify(resized.body)})`)
    await run(f.api, base, 'stty size', /40 120/)
    assert.equal((await f.api.post(`${base}/resize`, { cols: 9999, rows: 40 })).status, 400, 'a size beyond the cap is refused')
    const replay = await readStream(f.api, `${base}/stream`, /SUM-42/)
    assert.match(replay.snapshot?.data ?? '', /SUM-42/, 'a new stream (a reload) starts from the retained output')
  } finally {
    f.done()
  }
})

test('under workspace-write the terminal writes inside its session folder and is refused outside it', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('confine')
  try {
    const created = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
    assert.equal(created.status, 201, `a terminal is created (${JSON.stringify(created.body)})`)
    assert.equal(created.body.terminal.mode, 'workspace-write', 'under the session’s mode')
    const base = `/api/sessions/${f.a}/terminals/${created.body.terminal.id}`
    await run(f.api, base, `echo in > ${f.one}/in.txt; echo out > ${f.outside}/out.txt; ( echo child > ${f.outside}/child.txt ); echo WRITES-$((40+2))`, /WRITES-42/)
    assert.equal(existsSync(join(f.one, 'in.txt')), true, 'the inside write lands')
    assert.equal(existsSync(join(f.outside, 'out.txt')), false, 'the outside write is refused')
    assert.equal(existsSync(join(f.outside, 'child.txt')), false, 'from a subshell too')
  } finally {
    f.done()
  }
})

test('a terminal belongs to its session: another session cannot list, stream, type into, resize or close it', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('owner')
  try {
    const created = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
    const id = created.body.terminal.id
    const mine = `/api/sessions/${f.a}/terminals/${id}`
    const theirs = `/api/sessions/${f.b}/terminals/${id}`
    assert.equal((await f.api.call(`/api/sessions/${f.b}/terminals`)).body.terminals.length, 0, 'the other session lists none')
    assert.equal((await readStream(f.api, `${theirs}/stream`)).status, 404, 'nor streams it')
    assert.equal((await f.api.post(`${theirs}/input`, { data: 'echo LEAK\n' })).status, 404, 'nor types into it')
    assert.equal((await f.api.post(`${theirs}/resize`, { cols: 100, rows: 30 })).status, 404, 'nor resizes it')
    assert.equal((await f.api.call(theirs, { method: 'DELETE' })).status, 404, 'nor closes it')
    const other = await f.api.post(`/api/sessions/${f.b}/terminals`, {})
    const otherBase = `/api/sessions/${f.b}/terminals/${other.body.terminal.id}`
    await run(f.api, mine, 'echo ONLY-$((40+2))', /ONLY-42/)
    const seen = await readStream(f.api, `${otherBase}/stream`, /ONLY-/, 1500)
    assert.equal(/ONLY-/.test(seen.output), false, 'and one session’s output never reaches another session’s stream')
  } finally {
    f.done()
  }
})

test('the cap answers 409, and close, archive and shutdown each end the terminal’s whole process tree', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('lifetime')
  try {
    const list = await f.api.call(`/api/sessions/${f.a}/terminals`)
    const max = list.body.limits.maxTerminals
    assert.equal(max, 8, 'DSH’s maxTerminals')
    const ids = []
    for (let i = 0; i < max; i += 1) {
      const created = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
      assert.equal(created.status, 201, `terminal ${i + 1} of ${max} is created`)
      ids.push(created.body.terminal.id)
    }
    const over = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
    assert.equal(over.status, 409, 'one more is refused')
    assert.equal(over.body.code, 'limit')

    const jobIn = async (session, id) => {
      const out = await run(f.api, `/api/sessions/${session}/terminals/${id}`, 'sleep 300 & echo BG=$!', /BG=(\d+)/)
      return Number(/BG=(\d+)/.exec(out)[1])
    }
    const closedJob = await jobIn(f.a, ids[0])
    const closed = await f.api.call(`/api/sessions/${f.a}/terminals/${ids[0]}`, { method: 'DELETE' })
    assert.equal(closed.status, 200, 'a terminal closes')
    await settle()
    assert.equal(alive(closedJob), false, 'closing it ended its background job')

    const b = await f.api.post(`/api/sessions/${f.b}/terminals`, {})
    const archivedJob = await jobIn(f.b, b.body.terminal.id)
    const archived = await f.api.post(`/api/sessions/${f.b}/flags`, { archived: true })
    assert.equal(archived.status, 200, `the session is archived (${JSON.stringify(archived.body)})`)
    await settle()
    assert.equal(alive(archivedJob), false, 'archiving the session ended its terminal’s job')
    assert.equal((await f.api.call(`/api/sessions/${f.b}/terminals`)).body.terminals.length, 0, 'and its terminals are gone')
    const refused = await f.api.post(`/api/sessions/${f.b}/terminals`, {})
    assert.equal(refused.status, 409, 'an archived session gets no new terminal')
    assert.equal(refused.body.code, 'archived')

    const shutdownJob = await jobIn(f.a, ids[1])
    const exited = new Promise((resolve) => f.server.child.once('exit', resolve))
    f.server.child.kill('SIGTERM')
    await Promise.race([exited, settle(10_000)])
    await settle()
    assert.equal(alive(shutdownJob), false, 'stopping the server ended every terminal’s job, so a restart leaves no orphan')
  } finally {
    f.done()
  }
})

/** A create whose JSON body arrives in two parts with `between()` run in the gap, as a slow client would send it. */
function slowCreate(api, session, between) {
  const url = new URL(`/api/sessions/${session}/terminals`, api.origin)
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { cookie: api.cookie, 'content-type': 'application/json' } },
      (response) => {
        let text = ''
        response.on('data', (chunk) => (text += chunk))
        response.on('end', () => resolvePromise({ status: response.statusCode, body: text }))
      },
    )
    req.on('error', reject)
    req.write('{')
    setTimeout(async () => {
      try {
        await between()
      } finally {
        req.end('}')
      }
    }, 300)
  })
}

test('an archive that lands while a create is still being read ends that terminal and answers 409 (review A)', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('race')
  try {
    const raced = await slowCreate(f.api, f.b, async () => {
      const archived = await f.api.post(`/api/sessions/${f.b}/flags`, { archived: true })
      assert.equal(archived.status, 200, 'the archive landed mid-create')
    })
    assert.equal(raced.status, 409, `the create is refused (${raced.body})`)
    assert.equal(JSON.parse(raced.body).code, 'archived')
    await settle()
    assert.equal((await f.api.call(`/api/sessions/${f.b}/terminals`)).body.terminals.length, 0, 'and no terminal is left on the archived session')
  } finally {
    f.done()
  }
})

test('a change of the session’s mode ends its terminals, so none keeps a wider confinement (review B)', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('mode')
  try {
    const created = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
    assert.equal(created.body.terminal.mode, 'workspace-write')
    const out = await run(f.api, `/api/sessions/${f.a}/terminals/${created.body.terminal.id}`, 'sleep 300 & echo BG=$!', /BG=(\d+)\r?\n/)
    const job = Number(/BG=(\d+)/.exec(out)[1])
    const narrowed = await f.api.post(`/api/sessions/${f.a}/permission`, { mode: 'read-only' })
    assert.equal(narrowed.status, 200, `the mode changes (${JSON.stringify(narrowed.body)})`)
    await settle()
    assert.equal(alive(job), false, 'the terminal opened under the wider mode is gone, job and all')
    assert.equal((await f.api.call(`/api/sessions/${f.a}/terminals`)).body.terminals.length, 0)
    const again = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
    assert.equal(again.body.terminal.mode, 'read-only', 'a new terminal runs under the new mode')
  } finally {
    f.done()
  }
})

test('closing a terminal also ends a job that left its process tree for init (review E)', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('escaped')
  try {
    const created = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
    const base = `/api/sessions/${f.a}/terminals/${created.body.terminal.id}`
    const out = await run(f.api, base, '(sleep 300 & echo ESC=$! )', /ESC=(\d+)\r?\n/)
    const job = Number(/ESC=(\d+)/.exec(out)[1])
    assert.ok(alive(job), 'the escaped job runs')
    assert.equal((await f.api.call(base, { method: 'DELETE' })).status, 200)
    await settle()
    assert.equal(alive(job), false, 'and ends with the terminal')
  } finally {
    f.done()
  }
})

test('a stream that falls far behind is ended rather than buffered without bound, and a new one starts from a snapshot (review F)', async (context) => {
  if (!skipUnless(context, darwin, 'the PTY runs through BSD script(1); the util-linux form is not measured on this host')) return
  const f = await fixture('backpressure')
  try {
    const created = await f.api.post(`/api/sessions/${f.a}/terminals`, {})
    const base = `/api/sessions/${f.a}/terminals/${created.body.terminal.id}`
    const url = new URL(`${base}/stream`, f.api.origin)
    const stream = await new Promise((resolvePromise, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers: { cookie: f.api.cookie } }, resolvePromise)
      req.on('error', reject)
      req.end()
    })
    assert.equal(stream.statusCode, 200)
    let received = 0
    let ended = false
    stream.on('data', (chunk) => (received += chunk.length))
    stream.on('end', () => (ended = true))
    stream.on('error', () => (ended = true))
    await settle(300)
    stream.pause()
    const sent = await f.api.post(`${base}/input`, { data: "head -c 24000000 /dev/zero | tr '\\0' x; echo; echo FLOOD-$((40+2))\n" })
    assert.equal(sent.status, 200)
    const deadline = Date.now() + 20_000
    let replay
    while (Date.now() < deadline) {
      await settle(500)
      replay = await readStream(f.api, `${base}/stream`, /FLOOD-42/, 1500)
      if (/FLOOD-42/.test(replay.snapshot?.data ?? '')) break
    }
    assert.match(replay?.snapshot?.data ?? '', /FLOOD-42/, 'the flood finished')
    stream.resume()
    const until = Date.now() + 15_000
    while (!ended && Date.now() < until) await settle(200)
    assert.equal(ended, true, 'the paused stream was ended by the server')
    assert.ok(received < 24_000_000, `it did not carry the whole flood (${received} bytes)`)
    assert.equal(replay.snapshot.truncated, true, 'and a new stream starts from the retained tail')
  } finally {
    f.done()
  }
})
