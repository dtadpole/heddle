import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, httpConfig, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 8, the runtime-context half — a mode change reaches the **active loop**, and survives a restart.
 *
 * The policy-context check judges the snapshot sequence across turns; this file judges the two cases where a
 * "tell the model the expectation changed" mechanism is easy to get wrong: a switch made **while a turn is
 * running** (the next request of that same turn must carry the new snapshot) and a session **resumed by a fresh
 * process** (the retained snapshot must be reused, not rewritten, and a later change must still append).
 *
 * The double is local and scripted rather than model-shaped on purpose: it holds the first step open with a slow
 * bash call, which is the window a person's switch actually lands in.
 */

const CAPABILITY = 'a model told the session’s file policy mid-turn'

/** An HTTP completion double that answers with a scripted sequence, one completion per request. */
async function sequenceDouble(sequence) {
  const requests = []
  let index = 0
  const server = createHttpServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'double', object: 'model' }] }))
        return
      }
      requests.push(body)
      const step = sequence[Math.min(index, sequence.length - 1)]
      index += 1
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const delta =
        step?.toolCall !== undefined
          ? {
              role: 'assistant',
              tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.arguments ?? {}) } }],
            }
          : { role: 'assistant', content: step?.content ?? 'done' }
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  }
}

function startWeb(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(env.HEDDLE_HOME, 'sessions')]),
      { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
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
    }, 15_000)
  })
}

function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

function sessionOf(text) {
  for (const block of text.split('\n\n')) {
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (data === undefined) continue
    try {
      const payload = JSON.parse(data)
      if (typeof payload.session === 'string') return payload.session
    } catch {
      // not one of the turn's events
    }
  }
  return undefined
}

/** Start a turn and read just far enough to learn its session id; the reader continues afterwards. */
async function turnUntilSession(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(response.status, 200, 'the turn is accepted')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let done = false
  let session
  while (session === undefined && !done) {
    const chunk = await reader.read()
    done = chunk.done
    if (chunk.value !== undefined) text += decoder.decode(chunk.value, { stream: true })
    session = sessionOf(text)
  }
  assert.ok(typeof session === 'string', 'the turn named its session before the first tool ran')
  return {
    session,
    finish: async () => {
      while (!done) {
        const chunk = await reader.read()
        done = chunk.done
        if (chunk.value !== undefined) text += decoder.decode(chunk.value, { stream: true })
      }
      return text
    },
  }
}

async function turn(server, body) {
  const started = await turnUntilSession(server, body)
  await started.finish()
  return started.session
}

const snapshots = (body) => (body.match(/Current runtime context\. This snapshot supersedes earlier runtime-context snapshots\./g) ?? []).length
const policies = (body) => body.match(/Current heddle file policy: [a-z-]+/g) ?? []

async function logEvents(server, session) {
  const text = await request(server, `/api/sessions/${encodeURIComponent(session)}/log`).then((response) => response.text())
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('a switch made while the turn is running reaches that turn’s next request', async (context) => {
  if (!skipUnless(context, /^  web\b/m.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const home = isolatedHome('runtime-context-midturn')
  const work = fixtureDir('runtime-context-midturn-work')
  /** The first step asks for a slow command, which is the window the switch lands in. */
  const double = await sequenceDouble([
    { toolCall: { name: 'bash', arguments: { command: 'sleep 1.5' } } },
    { content: 'done' },
  ])
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  const server = await startWeb({ HEDDLE_HOME: home, HEDDLE_CONFIG: config })
  try {
    const started = await turnUntilSession(server, { prompt: 'run a slow command' })
    const changed = await request(server, `/api/sessions/${encodeURIComponent(started.session)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'read-only' }),
    })
    assert.equal(changed.status, 200, 'the switch is accepted while the turn runs')
    await started.finish()

    assert.equal(double.requests.length, 2, 'the turn asked the model twice')
    assert.equal(snapshots(double.requests[0]), 1, 'the first request carried one snapshot')
    assert.deepEqual(policies(double.requests[0]), ['Current heddle file policy: workspace-write'], 'under the mode the turn started in')
    assert.equal(snapshots(double.requests[1]), 2, 'the next request of the same turn carried the new snapshot after the old one')
    assert.deepEqual(policies(double.requests[1]), ['Current heddle file policy: workspace-write', 'Current heddle file policy: read-only'], 'so the active loop learned the expectation changed')

    const events = await logEvents(server, started.session)
    assert.equal(events.filter((event) => event.type === 'context/note' && event.origin === 'runtime-context').length, 2, 'both snapshots are durable')
    assert.deepEqual(events.filter((event) => event.type === 'permission/mode').map((event) => event.mode), ['read-only'], 'and the switch is its own log-only event')
  } finally {
    server.kill()
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})

test('a restarted process reuses the retained snapshot, and a later change still appends', async (context) => {
  if (!skipUnless(context, /^  web\b/m.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const home = isolatedHome('runtime-context-resume')
  const work = fixtureDir('runtime-context-resume-work')
  const double = await sequenceDouble([{ content: 'ok' }])
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  const env = { HEDDLE_HOME: home, HEDDLE_CONFIG: config }
  let server = await startWeb(env)
  try {
    const session = await turn(server, { prompt: 'first turn' })
    await request(server, `/api/sessions/${encodeURIComponent(session)}/permission`, { method: 'POST', body: JSON.stringify({ mode: 'read-only' }) })
    await turn(server, { session, prompt: 'second turn' })
    assert.equal(snapshots(double.requests.at(-1) ?? ''), 2, 'two snapshots before the restart')
    server.kill()
    server = await startWeb(env)

    /** A fresh process rebuilds the retained snapshot from the log; an unchanged request must not rewrite it. */
    await turn(server, { session, prompt: 'third turn' })
    assert.equal(snapshots(double.requests.at(-1) ?? ''), 2, 'the restarted process reused the retained snapshot instead of appending another')
    assert.deepEqual(policies(double.requests.at(-1) ?? ''), ['Current heddle file policy: workspace-write', 'Current heddle file policy: read-only'], 'and the history still says what changed and when')

    await request(server, `/api/sessions/${encodeURIComponent(session)}/permission`, { method: 'POST', body: JSON.stringify({ mode: 'workspace-write' }) })
    await turn(server, { session, prompt: 'fourth turn' })
    assert.equal(snapshots(double.requests.at(-1) ?? ''), 3, 'a change after the restart appends exactly one snapshot')
    assert.deepEqual(policies(double.requests.at(-1) ?? '').slice(-1), ['Current heddle file policy: workspace-write'], 'to the mode now in force')
  } finally {
    server.kill()
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})
