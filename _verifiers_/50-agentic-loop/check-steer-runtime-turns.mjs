import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A steer reaches a turn the server did not start (issue #176).
 *
 * DSH's agent takes a steer into whatever turn is running: its inbox is the session's, not the request's, and the
 * message joins the turn at its next step. A goal round is an ordinary turn of that session (dsh-goal). heddle's steer
 * route answered only turns that `POST /api/turn` started, so a steer into a running goal round got
 * `409 session/steer-unavailable` on both builds, and the prompt never reached the model.
 *
 * A Chat Completions double holds the round's first request until the check has steered, then asks for one bash call;
 * the round's next request must carry the steer. Every later request is held, so the goal driver cannot run on.
 *
 * A one-shot delegate child is the exception, as on the turn route: DSH's prompt, steer included, answers
 * `session/agent-busy` for a session that subagent routing owns, before any steer gate (dsh-api-session-controller
 * lib/index.js:128-142, 925-949). So a steer into a working delegate child is refused with that code, and nothing is
 * written into the child's turn.
 */

const CAPABILITY = 'the Web UI'

/** Spawn `heddle web` on a free port and resolve with its URL once it prints one. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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

/** The token in the printed URL, exchanged for the cookie the API calls use. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const STEER = 'STEER-176 also look at the tests'
const OBJECTIVE = 'GOAL-176 tidy the workspace'

async function double() {
  const requests = []
  const held = new Set()
  let release = () => {}
  const released = new Promise((resolvePromise) => {
    release = resolvePromise
  })
  let firstSeen = false
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', async () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (frames) => {
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
        response.end('data: [DONE]\n\n')
      }
      if (raw.includes('Create a concise title')) {
        send([{ choices: [{ index: 0, delta: { content: 'A title' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
        return
      }
      requests.push(raw)
      const hasToolResult = (() => {
        try {
          return (JSON.parse(raw).messages ?? []).some((message) => message?.role === 'tool')
        } catch {
          return false
        }
      })()
      if (!firstSeen && raw.includes(OBJECTIVE) && !hasToolResult) {
        firstSeen = true
        // Keep the round's first request streaming until the check has steered, then ask for one tool call.
        const beat = setInterval(() => response.write(': still working\n\n'), 500)
        await released
        clearInterval(beat)
        send([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_176_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo step-one' }) } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ])
        return
      }
      if (hasToolResult && requests.filter((one) => one.includes('call_176_1')).length === 1) {
        send([{ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
        return
      }
      // Anything later (the driver's next round) is held, so the goal cannot run on by itself.
      const beat = setInterval(() => response.write(': still working\n\n'), 1_000)
      held.add(beat)
      response.on('close', () => {
        clearInterval(beat)
        held.delete(beat)
      })
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    release: () => release(),
    firstSeen: () => firstSeen,
    close: () => {
      release()
      for (const beat of held) clearInterval(beat)
      server.close()
      server.closeAllConnections()
    },
  }
}

test('#176: a steer into a running goal round is accepted and reaches the round’s next model request', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('steer-goal-round')
  const work = fixtureDir('steer-goal-round-work')
  mkdirSync(work, { recursive: true })
  const provider = await double()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: work }) })
    const session = opened.body.session?.id ?? opened.body.id
    assert.equal(typeof session, 'string', `a session was opened (${JSON.stringify(opened.body)})`)
    const goal = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: `/goal ${OBJECTIVE}` }) })
    assert.equal(goal.body.kind, 'success', `/goal set the goal (${JSON.stringify(goal.body)})`)
    const end = Date.now() + 15_000
    while (!provider.firstSeen() && Date.now() < end) await sleep(100)
    assert.ok(provider.firstSeen(), 'the goal driver started a round, held at its first model request')

    const steered = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}/steer`, { method: 'POST', body: JSON.stringify({ prompt: STEER }) })
    assert.equal(steered.status, 200, `the steer into the running round is accepted\nsaw: ${steered.status} ${JSON.stringify(steered.body)}`)
    provider.release()
    const until = Date.now() + 15_000
    while (!provider.requests.some((one) => one.includes('call_176_1')) && Date.now() < until) await sleep(100)
    const next = provider.requests.find((one) => one.includes('call_176_1'))
    assert.ok(next !== undefined, "the round made its next model request after the tool call")
    assert.ok(next.includes(STEER), 'and that request carries the steer, at the round’s next step')
    await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/goal clear' }) })
  } finally {
    server.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})

test('#176: a steer into a working one-shot delegate child is refused as session/agent-busy, as the turn route refuses it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('steer-delegate-child')
  const work = fixtureDir('steer-delegate-child-work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({
    home,
    steps: [
      { toolCall: { name: 'delegate', arguments: { prompt: 'child task' } } },
      { text: 'parent started the child' },
      { purpose: 'subagent', toolCall: { name: 'bash', arguments: { command: 'sleep 3; echo child-worked' } } },
      { purpose: 'subagent', text: 'child answer' },
      { purpose: 'subagent-notice', text: 'parent read the notice' },
    ],
  })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'parent prompt', folder: work, new: true }),
    })
    const parent = JSON.parse(/event: session\ndata: (.*)/.exec(await turn.text())?.[1] ?? '{}').session
    assert.equal(typeof parent, 'string', 'the parent turn named its session')
    let child
    const end = Date.now() + 8_000
    while (child === undefined && Date.now() < end) {
      const listed = (await api(server.url, cookie, '/api/sessions')).body
      child = (Array.isArray(listed) ? listed : []).find((entry) => entry.parentSession === parent)?.id
      if (child === undefined) await sleep(100)
    }
    assert.equal(typeof child, 'string', 'the child session is listed under its parent')
    const steered = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(child)}/steer`, { method: 'POST', body: JSON.stringify({ prompt: 'STEER-176 into the child' }) })
    assert.equal(steered.status, 409, `the steer is refused\nsaw: ${steered.status} ${JSON.stringify(steered.body)}`)
    assert.equal(steered.body.code, 'session/agent-busy', `with the turn route's code\nsaw: ${JSON.stringify(steered.body)}`)
    const read = JSON.stringify((await api(server.url, cookie, `/api/sessions/${encodeURIComponent(child)}`)).body)
    assert.ok(!read.includes('STEER-176 into the child'), 'and nothing was written into the child')
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
