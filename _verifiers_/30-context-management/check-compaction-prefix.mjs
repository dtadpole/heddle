import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A compaction's summary request is a prefix of the conversation's own requests (#209): the system message, the tools
 * and the span the turns sent, then the instruction, so the provider's prompt cache is reused.
 *
 * Measured before, on main 40182eed5, on both builds: a turn request began with the system message and offered the
 * profile's tools, and the summary request (`/compact` or automatic) sent the same messages without the system message
 * and without `tools`. turn.messages[1:] equalled summary.messages[:-1]. So the summary call, the largest request a
 * long session makes, shared no prefix with anything the provider had seen and was billed uncached in full.
 *
 * DSH: dsh-compaction-basic `buildSummarizationInput` is the system head, the header's tool schemas and the region's
 * messages, and `summarizeWithLlm` sends them with the tools: "Keeping the conversation's own system prompt, tools,
 * and message prefix in front of it makes the auxiliary call a genuine prefix of the last routed request, so the
 * provider's KV cache is reused instead of invalidated."
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

/** The summariser's directive, in either of the wordings the builds have used. */
function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

/** check-empty-answer-compact's sizes: with a 40,000-token window the trigger is 32,000. */
const WINDOW = 40_000
const FIRST = `HERON-209 keep this in mind: ${'the quick brown fox jumps over the lazy dog, '.repeat(1950)}`
const SECOND = `And now the question: ${'a lazy dog sleeps under the quick brown fox, '.repeat(500)}`

/** A chat double that answers every turn and summary at once and keeps every request body, parsed. */
async function recordingDouble() {
  const state = { turns: [], summaries: [] }
  const frame = (response, delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
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
      const summary = isSummaryRequest(body)
      ;(summary ? state.summaries : state.turns).push(JSON.parse(body))
      frame(response, { role: 'assistant', content: summary ? 'a compact briefing of the conversation so far' : 'answered' })
      frame(response, {}, 'stop')
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

/** A server over a fresh home whose one endpoint is `double`. */
async function withServer(label, double, body) {
  const home = fixtureDir(label)
  const sessions = join(home, 'sessions')
  let server
  try {
    writeJson(join(home, 'heddle.json'), {
      default: 'double',
      endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true, contextWindow: WINDOW }],
    })
    server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', sessions], { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') })
    await body(server)
  } finally {
    if (server) await killServer(server)
    await double.close()
    removeDir(home)
  }
}

/** The summary request is the last turn request's prefix plus one instruction, with the same tools. */
function assertPrefix(summary, turn, label) {
  assert.ok(summary !== undefined && turn !== undefined, `${label}: a turn request and a summary request were made`)
  const replayed = summary.messages.slice(0, -1)
  const roles = (body) => body.messages.map((message) => message.role).join(',')
  assert.equal(summary.messages.at(-1)?.role, 'user', `${label}: the summary ends with the instruction`)
  assert.ok(replayed.length > 1, `${label}: the summary replays the conversation (${roles(summary)})`)
  assert.deepEqual(replayed, turn.messages.slice(0, replayed.length), `${label}: the summary's messages before the instruction are a prefix of the last turn request's\nturn:    ${roles(turn)}\nsummary: ${roles(summary)}`)
  assert.equal(replayed[0]?.role, 'system', `${label}: starting with the turn's own system message`)
  assert.ok(Array.isArray(summary.tools) && summary.tools.length > 0, `${label}: the summary offers tools (${summary.tools?.length ?? 0})`)
  assert.deepEqual(summary.tools, turn.tools, `${label}: the same tools, in the same order, as the turn request`)
}

test('a manual /compact sends the last turn request\'s system message, messages and tools, then the instruction (#209)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await recordingDouble()
  await withServer('compaction-prefix-manual', double, async (server) => {
    const first = await turn(server, { prompt: 'Say hello.' })
    const session = first.session
    assert.ok(typeof session === 'string', 'the first turn named its session')
    await turn(server, { session, prompt: 'And again.' })
    const said = await compact(server, session)
    assert.equal(said.kind, 'success', `/compact compacts (${JSON.stringify(said).slice(0, 300)})`)
    assert.equal(double.state.summaries.length, 1, 'with one summary call')
    assertPrefix(double.state.summaries[0], double.state.turns.at(-1), '/compact')
  })
})

test('an automatic compaction before a turn over the trigger sends the same prefix (#209)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await recordingDouble()
  await withServer('compaction-prefix-automatic', double, async (server) => {
    const first = await turn(server, { prompt: FIRST })
    const session = first.session
    assert.ok(typeof session === 'string', 'the first turn named its session')
    const before = double.state.turns.at(-1)
    const over = await turn(server, { session, prompt: SECOND })
    assert.match(over.text, /answered/, `the turn over the trigger is answered\n${over.text.slice(-300)}`)
    assert.equal(double.state.summaries.length, 1, 'after one automatic summary')
    assertPrefix(double.state.summaries[0], before, 'automatic')
  })
})
