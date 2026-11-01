import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, sessionsUnder, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A person's `/goal pause` aborts the goal round already running (issue #190).
 *
 * DSH's round driver: "completion, pause, and blocking suppress continuation; a host-initiated pause also aborts the
 * turn already running, while a model-initiated pause inside its own turn finishes normally" (dsh-goal-round-driver,
 * the `goal/changed` listener cancels the running agent with `{kind: 'user'}` and keeps its inbox). heddle recorded
 * the pause and let the round run to its natural end on both builds, so the model's whole answer, and any tool call
 * it made, landed after "Goal paused".
 *
 * A Chat Completions double keeps the round's model request streaming and would answer only after 8 s. The check
 * pauses the goal 1 s into the request: the round must end stopped at once, and the late answer must never be written.
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

const OBJECTIVE = 'GOAL-190 keep tidying'
const LATE = 'LATE-ANSWER-190'

async function double() {
  let rounds = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (text) => {
        for (const frame of [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
        response.end('data: [DONE]\n\n')
      }
      if (raw.includes('Create a concise title')) return send('A title')
      if (raw.includes(OBJECTIVE)) rounds += 1
      // The round's answer comes only after 8 s, with a comment every 500 ms so nothing idles out before then.
      const beat = setInterval(() => response.write(': still working\n\n'), 500)
      const late = setTimeout(() => {
        clearInterval(beat)
        send(LATE)
      }, 8_000)
      response.on('close', () => {
        clearInterval(beat)
        clearTimeout(late)
      })
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    rounds: () => rounds,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

test('#190: a person’s /goal pause aborts the round in flight, and its late answer is never written', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('goal-pause-aborts')
  const work = fixtureDir('goal-pause-aborts-work')
  mkdirSync(work, { recursive: true })
  const provider = await double()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const root = join(home, 'sessions')
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', root],
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
    while (provider.rounds() === 0 && Date.now() < end) await sleep(100)
    assert.equal(provider.rounds(), 1, 'the driver started a round, its model request in flight')
    await sleep(1_000)

    const paused = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/goal pause' }) })
    assert.equal(paused.body.kind, 'success', `the pause is accepted (${JSON.stringify(paused.body)})`)
    const pausedAt = Date.now()
    const events = () => {
      try {
        return readTranscript(join(root, session))
      } catch {
        return []
      }
    }
    let closed
    while (closed === undefined && Date.now() - pausedAt < 6_000) {
      closed = events().findLast((event) => event.type === 'turn/completed')
      if (closed === undefined) await sleep(100)
    }
    assert.ok(closed !== undefined, `the round ended within 6 s of the pause (its answer was due 7 s later)`)
    // Recorded as Stop records it: TS marks the turn's close `stopped`, Rust the answer's `ended` (check-goal-stop's rule).
    const answer = events().findLast((event) => event.type === 'assistant/completed')
    assert.ok(
      closed.stopped === true || (answer?.ended ?? []).includes('stopped by the caller'),
      `the round ended stopped, as Stop ends it\n${JSON.stringify({ closed, answer })}`,
    )
    await sleep(8_000 - (Date.now() - pausedAt) + 500)
    assert.ok(!JSON.stringify(events()).includes(LATE), 'the late answer was never written')
    assert.equal(provider.rounds(), 1, 'and no further round started')
  } finally {
    server.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})
