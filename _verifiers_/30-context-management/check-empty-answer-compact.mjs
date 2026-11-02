import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A session that holds an empty answer still compacts: by `/compact`, and by a turn that crosses the trigger (#214).
 *
 * Measured before, on main 61570627a, on both builds: once a session held a run that streamed only its `done` (the
 * provider answered `finish_reason: "stop"` with no content), every compaction of it threw "compaction: the
 * measurement is of a different surface than the one on disk". `/compact` answered that as an error, and every turn
 * over the trigger failed with it before any request was sent (TS `turn/failed`; Rust a completed turn carrying the
 * error). Nothing the person could do in the session cleared it. The plan compared the measurement with every surface
 * node, but the measurement prices only the nodes that derive a message, and a done-only run derives none.
 *
 * The issue also names a TS-only trigger, seen live: a Stop during a model's silent thinking, before the first token,
 * is logged as the same done-only run. A local double could not produce it on main. A Stop after the stream opened is
 * logged `assistant/completed aborted` with no chunk, and that session compacts. That held for headers only, for a
 * role-only first delta, and for an Anthropic `message_start`, thinking block and `ping`. The plan fix does not depend
 * on how the done-only run came about, so the cases below pin the shape itself.
 *
 * DSH: an empty answer is an ordinary turn. It costs nothing in the measurement, and a later compaction can shadow it
 * like any other node.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

/** The summariser's directive, in either of the wordings the builds have used. */
function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

/**
 * check-compaction-stop's sizes. With a 40,000-token window the trigger is 32,000: the first prompt (about 21,800) keeps
 * the first turns under it, and the second (about 5,600) takes the next request over it.
 */
const WINDOW = 40_000
const FIRST = `HERON-214 keep this in mind: ${'the quick brown fox jumps over the lazy dog, '.repeat(1950)}`
const SECOND = `And now the question: ${'a lazy dog sleeps under the quick brown fox, '.repeat(500)}`
const MEASUREMENT = 'the measurement is of a different surface'

/**
 * A chat double. The turn named by `empty` is answered with an empty stream (only `finish_reason: "stop"`). Every other
 * turn, and every summary, is answered at once. Turns are counted from 1; request bodies are kept.
 */
async function emptyingDouble({ empty = 0 } = {}) {
  const state = { turns: [], summaries: [] }
  const finish = (response) => {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
  const delta = (response, content) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isSummaryRequest(body)) {
        state.summaries.push(body)
        delta(response, 'a compact briefing of the conversation so far')
        return finish(response)
      }
      state.turns.push(body)
      const n = state.turns.length
      if (n === empty) return finish(response)
      delta(response, 'answered')
      finish(response)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

/** Start the Web UI and resolve once it prints its URL. */
function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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

function killServer(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return resolve()
    server.child.once('exit', () => resolve())
    server.child.kill('SIGKILL')
  })
}

/** The printed URL's token, attached to every API request as the page's cookie is. */
function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

/** The session a streamed turn body named. */
function sessionOf(text) {
  const named = /event: session\ndata: (\{.*\})/.exec(text)
  return named ? JSON.parse(named[1]).session : undefined
}

/** Post a turn and read it to its end; the session it ran in, and the streamed body. */
async function turn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted (${String(body.prompt).slice(0, 40)})\n${text.slice(0, 400)}`)
  return { session: sessionOf(text), text }
}

/** Run `/compact` in the session; the command's answer. */
async function compact(server, session) {
  const response = await request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
  return response.json()
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

/** A server over a fresh home whose one endpoint is `double`; `body` gets the server and the session folder. */
async function withServer(label, double, body) {
  const home = fixtureDir(label)
  writeJson(join(home, 'heddle.json'), {
    default: 'double',
    endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true, contextWindow: WINDOW }],
  })
  const sessions = join(home, 'sessions')
  let server
  try {
    server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', sessions], { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') })
    await body(server, sessions)
  } finally {
    if (server) await killServer(server)
    await double.close()
    removeDir(home)
  }
}

/** The first turn (the long prompt) and the empty second; the session. */
async function emptyAnswerSession(server, double) {
  const first = await turn(server, { prompt: FIRST })
  assert.match(first.text, /answered/, `the first turn is answered\n${first.text.slice(-300)}`)
  const session = first.session
  assert.ok(typeof session === 'string', 'the first turn named its session')
  const empty = await turn(server, { session, prompt: 'Say nothing at all.' })
  assert.doesNotMatch(empty.text, /event: error/, `the empty answer is an ordinary turn\n${empty.text.slice(-400)}`)
  assert.equal(double.state.turns.length, 2)
  return session
}

test('after an empty answer, /compact still compacts the session (#214)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await emptyingDouble({ empty: 2 })
  await withServer('empty-answer-compact', double, async (server, sessions) => {
    const session = await emptyAnswerSession(server, double)
    const said = await compact(server, session)
    assert.equal(said.kind, 'success', `/compact compacts the session (${JSON.stringify(said).slice(0, 300)})`)
    assert.match(String(said.text), /^Compacted /, `in the words a compaction answers with (${JSON.stringify(said).slice(0, 300)})`)
    assert.equal(double.state.summaries.length, 1, 'with one summary call')
    const types = readTranscript(join(sessions, session)).map((event) => event.type)
    assert.ok(types.includes('compaction/end'), `the log holds the landed compaction\n${types.join(' ')}`)

    /** And the session goes on: the next turn reads the summary in place of the span. */
    const next = await turn(server, { session, prompt: 'NEXT turn' })
    assert.match(next.text, /answered/, `the next turn is answered\n${next.text.slice(-300)}`)
    assert.ok(!double.state.turns.at(-1).includes('HERON-214 keep this in mind'), 'its request carries the summary, not the folded prompt')
  })
})

test('after an empty answer, a turn that crosses the trigger compacts and is answered (#214)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await emptyingDouble({ empty: 2 })
  await withServer('empty-answer-trigger', double, async (server, sessions) => {
    const session = await emptyAnswerSession(server, double)
    const over = await turn(server, { session, prompt: SECOND })
    assert.ok(!over.text.includes(MEASUREMENT), `the turn over the trigger does not fail on the measurement\n${over.text.slice(-500)}`)
    assert.doesNotMatch(over.text, /event: error/, `the turn over the trigger is not an error\n${over.text.slice(-500)}`)
    assert.match(over.text, /answered/, `the turn over the trigger is answered\n${over.text.slice(-300)}`)
    assert.equal(double.state.summaries.length, 1, 'after one automatic summary')
    assert.equal(double.state.turns.length, 3, 'and one model call for the turn')
    const events = readTranscript(join(sessions, session))
    const types = events.map((event) => event.type)
    assert.ok(types.includes('compaction/end'), `the log holds the landed compaction\n${types.join(' ')}`)
    assert.ok(!types.includes('turn/failed'), `and no failed turn\n${types.join(' ')}`)

    /** A second turn over the line does not fail either. */
    const again = await turn(server, { session, prompt: SECOND })
    assert.ok(!again.text.includes(MEASUREMENT), `the next turn does not fail on the measurement\n${again.text.slice(-500)}`)
    assert.match(again.text, /answered/, `the next turn is answered\n${again.text.slice(-300)}`)
  })
})
