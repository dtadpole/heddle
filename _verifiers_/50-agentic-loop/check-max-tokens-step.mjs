import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A step the provider cut at its output limit ends the turn, and none of its tool calls run (#208).
 *
 * Measured before, on main c41a5a07d, on both builds: a step answered with `finish_reason: "length"` ran its calls and
 * the turn went on. A complete `bash` call ran (its result went back, a second round followed, the turn ended `stop`).
 * A call whose arguments were cut off was answered INVALID_ARGS and the model was asked again, every round, at full
 * output cost.
 *
 * DSH: `dsh-agent-loop` `step()` returns `max-tokens` once the assistant message is recorded, before
 * `executeToolCalls`. The turn ends `max-tokens`, and dsh-client-ui-chat draws "Output token limit reached" with its
 * hint. heddle answers each call of the cut step as not run, so the request pairing holds. The turn's record says
 * `max_output_tokens`, so a goal round disarms (the driver reads that already), and its `ended` is DSH's notice.
 *
 * An openai-chat double answers on the wire, so each build's own reader maps `length`. No other model is involved.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'
const NOTICE = 'output token limit reached. The reply was cut off; earlier output is preserved in the conversation. Send "continue" to let the model resume.'

/** A chat double that answers turns from a queue of `{ text?, call?, raw? }` steps, each finished `length` unless `finish` says. */
async function cuttingDouble(steps) {
  const state = { requests: [] }
  const frame = (response, delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
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
      state.requests.push(JSON.parse(body))
      const step = steps.shift() ?? { text: 'done', finish: 'stop' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (step.text !== undefined) frame(response, { role: 'assistant', content: step.text })
      if (step.call !== undefined) {
        const args = step.raw ?? JSON.stringify(step.call.arguments)
        frame(response, { tool_calls: [{ index: 0, id: step.call.id, type: 'function', function: { name: step.call.name, arguments: args } }] })
      }
      frame(response, {}, step.finish ?? 'length')
      response.end('data: [DONE]\n\n')
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
        resolvePromise({ child, url: match[1] })
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

/** Post a turn and read it to its end; the session it ran in, and the streamed body. */
async function turn(server, body) {
  const base = new URL(server.url)
  const target = new URL('/api/turn', base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted\n${text.slice(0, 400)}`)
  const named = /event: session\ndata: (\{.*\})/.exec(text)
  return { session: named ? JSON.parse(named[1]).session : undefined, text }
}

/** A server over a fresh home whose one endpoint is `double`, with the workspace as the session folder. */
async function withServer(label, double, body) {
  const home = fixtureDir(label)
  const work = join(home, 'work')
  const sessions = join(home, 'sessions')
  let server
  try {
    mkdirSync(work, { recursive: true })
    writeJson(join(home, 'heddle.json'), { default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true }] })
    server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', sessions], { HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') })
    await body(server, sessions, work)
  } finally {
    if (server) await killServer(server)
    await double.close()
    removeDir(home)
  }
}

const supportsWeb = async () => /web/.test((await runCli(['--help'])).stdout)

/** What a session's log says about the turn: the tool answers, the record, and whether a job ran. */
function readOut(sessions, session) {
  const events = readTranscript(join(sessions, session))
  const answers = events.filter((event) => event.type === 'message' && event.message?.role === 'tool').map((event) => ({ id: event.message.toolCallId, text: (event.message.content ?? []).map((part) => part.text ?? '').join('') }))
  const completed = events.filter((event) => event.type === 'assistant/completed').at(-1)
  return { events, answers, completed, jobs: events.filter((event) => event.type === 'job/registered').length }
}

test('a complete call in a step cut at the output limit is not run, and the turn ends there as max-tokens (#208)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await cuttingDouble([
    // The output would read TOOLRAN-208; the arguments never spell it, so the stream can only show it if the call ran.
    { text: 'Running it now.', call: { id: 'call_bash_1', name: 'bash', arguments: { command: "printf 'TOOL%s' RAN-208" } } },
    { text: 'a second round that must not happen', finish: 'stop' },
  ])
  await withServer('max-tokens-complete', double, async (server, sessions, work) => {
    const done = await turn(server, { prompt: 'Run the command.', folder: work })
    assert.ok(typeof done.session === 'string', 'the turn named its session')
    assert.equal(double.state.requests.length, 1, 'one model request: the turn did not go on after the cut')
    assert.doesNotMatch(done.text, /TOOLRAN-208/, 'the command never ran, so its output never appears')
    const out = readOut(sessions, done.session)
    assert.equal(out.jobs, 0, 'no job was registered for the call')
    assert.deepEqual(out.answers.map((answer) => answer.id), ['call_bash_1'], 'the call is still answered in the log')
    assert.match(out.answers[0].text, /^error \(MAX_TOKENS\): the step was cut at the output token limit/, `as not run (${out.answers[0].text})`)
    assert.equal(out.completed?.finishReason, 'max_output_tokens', 'the turn records max-tokens, so a goal disarms')
    assert.deepEqual(out.completed?.ended, [NOTICE], "and its notice is DSH's, once")
  })
})

test('a call whose arguments the cut left unfinished is not run, and the model is not asked again round after round (#208)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const cut = { call: { id: 'call_bash_2', name: 'bash' }, raw: '{"command":"echo TRUNC' }
  const double = await cuttingDouble([cut, { ...cut }, { ...cut }, { text: 'gave up', finish: 'stop' }])
  await withServer('max-tokens-truncated', double, async (server, sessions, work) => {
    const done = await turn(server, { prompt: 'Write the big file.', folder: work })
    assert.equal(double.state.requests.length, 1, 'one cut, one request')
    const out = readOut(sessions, done.session)
    assert.equal(out.answers.length, 1)
    assert.match(out.answers[0].text, /^error \(MAX_TOKENS\): /, `not INVALID_ARGS (${out.answers[0].text})`)
    assert.equal(out.completed?.finishReason, 'max_output_tokens')
    assert.deepEqual(out.completed?.ended, [NOTICE])
  })
})

test('a healthy tool step still runs its call and the turn goes on', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await cuttingDouble([
    { call: { id: 'call_bash_3', name: 'bash', arguments: { command: 'echo HEALTHY-208' } }, finish: 'tool_calls' },
    { text: 'It printed HEALTHY-208.', finish: 'stop' },
  ])
  await withServer('max-tokens-healthy', double, async (server, sessions, work) => {
    const done = await turn(server, { prompt: 'Run the command.', folder: work })
    assert.equal(double.state.requests.length, 2, 'the result went back to the model')
    const out = readOut(sessions, done.session)
    assert.match(out.answers[0]?.text ?? '', /HEALTHY-208/, 'the command ran')
    assert.equal(out.completed?.finishReason, 'stop')
    assert.equal(out.completed?.ended, undefined, 'and the turn carries no notice')
  })
})
